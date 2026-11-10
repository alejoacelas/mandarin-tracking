package com.mandarintracking.simulators

import android.app.Activity
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Bundle
import android.widget.TextView
import java.net.ServerSocket
import java.net.Socket
import kotlin.concurrent.thread

/**
 * Makes a hub on the host discoverable inside the emulator: advertises _mandarintrack._tcp on
 * port 47800 of the emulator and forwards connections to 10.0.2.2:<target> (the host).
 * am start -n com.mandarintracking.hubbeacon/com.mandarintracking.simulators.BeaconActivity --ei target 47811
 */
class BeaconActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val target = intent.getIntExtra("target", 47800)
        setContentView(TextView(this).apply { text = "Advertising hub on :$PORT -> 10.0.2.2:$target" })
        if (started) return
        started = true
        thread(isDaemon = true) { forward(target) }
        val info = NsdServiceInfo().apply {
            serviceName = "Mandarin Tracker test hub"
            serviceType = "_mandarintrack._tcp"
            port = PORT
        }
        getSystemService(NsdManager::class.java).registerService(info, NsdManager.PROTOCOL_DNS_SD, object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(i: NsdServiceInfo) {}
            override fun onRegistrationFailed(i: NsdServiceInfo, code: Int) {}
            override fun onServiceUnregistered(i: NsdServiceInfo) {}
            override fun onUnregistrationFailed(i: NsdServiceInfo, code: Int) {}
        })
    }

    private fun forward(target: Int) {
        val server = ServerSocket(PORT)
        while (true) {
            val client = server.accept()
            thread(isDaemon = true) {
                try {
                    Socket("10.0.2.2", target).use { up ->
                        val a = thread(isDaemon = true) { pipe(client, up) }
                        pipe(up, client)
                        a.join(1000)
                    }
                } catch (e: Exception) {
                } finally {
                    client.close()
                }
            }
        }
    }

    private fun pipe(from: Socket, to: Socket) {
        try {
            from.getInputStream().copyTo(to.getOutputStream())
            to.shutdownOutput()
        } catch (e: Exception) {
        }
    }

    companion object {
        const val PORT = 47800
        @Volatile var started = false
    }
}
