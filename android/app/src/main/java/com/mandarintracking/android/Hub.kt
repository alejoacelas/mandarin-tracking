package com.mandarintracking.android

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import com.mandarintracking.android.core.HttpResult
import com.mandarintracking.android.core.HubTransport
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetAddress
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Plain HTTP to the hub on the local network. */
class HttpTransport(private val address: String, private val token: String?) : HubTransport {
    override fun post(path: String, body: String): HttpResult = request("POST", "/api/v1/$path", body)

    fun request(method: String, path: String, body: String?): HttpResult {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL("http://$address$path").openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = 8_000
                readTimeout = 20_000
                useCaches = false
                setRequestProperty("Content-Type", "application/json")
                token?.let { setRequestProperty("Authorization", "Bearer $it") }
            }
            if (body != null) {
                conn.doOutput = true
                conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val code = conn.responseCode
            val text = (if (code >= 400) conn.errorStream else conn.inputStream)?.use { it.readBytes().toString(Charsets.UTF_8) }
            val date = conn.getHeaderFieldDate("Date", 0L).takeIf { it > 0 }
            HttpResult(code, text, date)
        } catch (e: Exception) {
            HttpResult(-1, null, error = "${e.javaClass.simpleName}: ${e.message}")
        } finally {
            conn?.disconnect()
        }
    }
}

/** Finds the hub: the address typed in settings, else the last one that worked, else Bonjour/NSD. */
object HubLocator {
    const val SERVICE_TYPE = "_mandarintrack._tcp"

    /** Candidate addresses in the order to try. Discovery runs only when needed. */
    fun candidates(c: Context, discover: Boolean = true): Sequence<String> = sequence {
        val prefs = Prefs(c)
        prefs.manualHub?.let { yield(it); return@sequence }
        prefs.lastHub?.let { yield(it) }
        if (discover) yieldAll(discover(c).filter { it != prefs.lastHub })
    }

    /**
     * Runs [call] against each candidate until one answers and [accept]s the answer. The local
     * network may hold more than one hub (two Macs), so a hub that answers but refuses (wrong
     * code, unknown token) doesn't stop the search. If none accepts, returns the first refusal.
     */
    fun <T> withHub(c: Context, accept: (HttpResult) -> Boolean, call: (String) -> Pair<HttpResult, T>): Pair<String, T>? {
        var lastFailure: String? = null
        var refused: Pair<String, T>? = null
        for (addr in candidates(c)) {
            val (res, value) = call(addr)
            if (res.code > 0 && accept(res)) {
                Prefs(c).lastHub = addr
                return addr to value
            }
            if (res.code > 0) refused = refused ?: (addr to value) else lastFailure = res.error
        }
        if (refused == null) Prefs(c).lastSyncError = lastFailure ?: "No hub found on this network"
        return refused
    }

    /** Blocking NSD discovery. Returns "host:port" for each resolved service. */
    fun discover(c: Context, timeoutMs: Long = 6_000): List<String> {
        val nsd = c.getSystemService(NsdManager::class.java) ?: return emptyList()
        val found = java.util.Collections.synchronizedList(ArrayList<NsdServiceInfo>())
        val listener = object : NsdManager.DiscoveryListener {
            override fun onServiceFound(info: NsdServiceInfo) { found += info }
            override fun onServiceLost(info: NsdServiceInfo) {}
            override fun onDiscoveryStarted(type: String) {}
            override fun onDiscoveryStopped(type: String) {}
            override fun onStartDiscoveryFailed(type: String, code: Int) { lastDiscoveryError = "discovery failed ($code)" }
            override fun onStopDiscoveryFailed(type: String, code: Int) {}
        }
        try {
            nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
            Thread.sleep(timeoutMs)
        } catch (e: Exception) {
            lastDiscoveryError = e.toString()
            return emptyList()
        } finally {
            try { nsd.stopServiceDiscovery(listener) } catch (e: Exception) {}
        }
        val out = ArrayList<String>()
        for (info in found.toList().distinctBy { it.serviceName }) {
            resolve(nsd, info)?.let { out += it }
        }
        lastDiscovered = out.toList()
        return out
    }

    @Suppress("DEPRECATION")
    private fun resolve(nsd: NsdManager, info: NsdServiceInfo): String? {
        val latch = CountDownLatch(1)
        var result: String? = null
        nsd.resolveService(info, object : NsdManager.ResolveListener {
            override fun onResolveFailed(i: NsdServiceInfo, code: Int) { latch.countDown() }
            override fun onServiceResolved(i: NsdServiceInfo) {
                val hosts: List<InetAddress> = if (Build.VERSION.SDK_INT >= 34) i.hostAddresses else listOfNotNull(i.host)
                val host = hosts.firstOrNull { it is Inet4Address } ?: hosts.firstOrNull()
                if (host != null) result = format(host, i.port)
                latch.countDown()
            }
        })
        latch.await(5, TimeUnit.SECONDS)
        return result
    }

    private fun format(host: InetAddress, port: Int): String {
        val h = host.hostAddress ?: return ""
        return if (host is Inet4Address) "$h:$port" else "[${h.substringBefore('%')}]:$port"
    }

    @Volatile var lastDiscovered: List<String> = emptyList()
    @Volatile var lastDiscoveryError: String? = null
}

object Pairing {
    sealed class Outcome {
        data class Paired(val hub: String) : Outcome()
        object WrongCode : Outcome()
        data class Failed(val message: String) : Outcome()
    }

    /** Pairs with the hub using the code from its dashboard. Blocking; call off the main thread. */
    fun pair(c: Context, code: String): Outcome {
        val body = JSONObject()
            .put("code", code.trim())
            .put("device_name", deviceName())
            .put("kind", "android")
            .toString()
        val got = HubLocator.withHub(c, accept = { it.code != 403 }) { addr ->
            val r = HttpTransport(addr, null).post("pair", body)
            r to r
        } ?: return Outcome.Failed("No hub found on this Wi-Fi. Check that the Mac is on and on the same network, or type its address under Advanced.")
        val (addr, res) = got
        return when (res.code) {
            200 -> try {
                val j = JSONObject(res.body ?: "")
                val prefs = Prefs(c)
                prefs.token = j.getString("token")
                prefs.deviceId = j.optString("device_id")
                prefs.pairingLost = false
                prefs.lastHub = addr
                Store.get(c).resendAll()
                Store.get(c).resendAllProblems()
                Outcome.Paired(addr)
            } catch (e: Exception) {
                Outcome.Failed("The hub's answer was unreadable: ${e.message}")
            }
            403 -> Outcome.WrongCode
            else -> Outcome.Failed("The hub answered ${res.code}: ${res.body?.take(200)}")
        }
    }

    fun deviceName(): String {
        val m = Build.MODEL ?: "Android"
        val brand = Build.MANUFACTURER?.replaceFirstChar { it.uppercase() } ?: ""
        return if (m.startsWith(brand, ignoreCase = true)) m else "$brand $m".trim()
    }
}
