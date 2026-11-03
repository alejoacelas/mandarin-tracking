// Records how long each Mac app is in front while you're at the computer, and serves the daily
// totals to the extension at http://127.0.0.1:47321/. Every 5 s, the frontmost app gets 5 s,
// unless the screen is locked or there has been no keyboard, mouse or trackpad input for
// IDLE_S. Needs no permissions. Totals live in
// ~/Library/Application Support/mandarin-tracking/apptime.json as
// {"days": {"YYYY-MM-DD": {"<bundle id>": {"name": "...", "seconds": n}}}}.
import AppKit
import CoreGraphics
import Network

let TICK_S = 5.0
let IDLE_S = 120.0
let PORT: NWEndpoint.Port = 47321
let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/mandarin-tracking")
let file = dir.appendingPathComponent("apptime.json")

struct App: Codable { var name: String; var seconds: Double }
struct Store: Codable { var days: [String: [String: App]] }

var store = (try? JSONDecoder().decode(Store.self, from: Data(contentsOf: file))) ?? Store(days: [:])
var dirty = false

func today() -> String {
  let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyy-MM-dd"
  return f.string(from: Date())
}

func save() {
  guard dirty else { return }
  try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  if let d = try? JSONEncoder().encode(store) { try? d.write(to: file, options: .atomic); dirty = false }
}

func screenLocked() -> Bool {
  guard let s = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
  return (s["CGSSessionScreenIsLocked"] as? Bool) ?? false
}

func tick() {
  let idle = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
  guard idle < IDLE_S, !screenLocked(), let app = NSWorkspace.shared.frontmostApplication,
        let id = app.bundleIdentifier else { return }
  let day = today()
  var a = store.days[day]?[id] ?? App(name: app.localizedName ?? id, seconds: 0)
  a.seconds += TICK_S
  store.days[day, default: [:]][id] = a
  dirty = true
}

// Plain HTTP on the loopback interface only. No CORS headers, so web pages can't read it; the
// extension can, through its host permission.
func serve() throws {
  let params = NWParameters.tcp
  params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: PORT)
  params.allowLocalEndpointReuse = true
  let listener = try NWListener(using: params)
  listener.newConnectionHandler = { conn in
    conn.start(queue: .main)
    conn.receive(minimumIncompleteLength: 1, maximumLength: 8192) { _, _, _, _ in
      let body = (try? JSONEncoder().encode(store)) ?? Data("{}".utf8)
      let head = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
      conn.send(content: Data(head.utf8) + body, completion: .contentProcessed { _ in conn.cancel() })
    }
  }
  listener.stateUpdateHandler = { state in
    if case .failed(let e) = state { FileHandle.standardError.write(Data("listener failed: \(e)\n".utf8)); exit(1) }
  }
  listener.start(queue: .main)
}

try serve()
Timer.scheduledTimer(withTimeInterval: TICK_S, repeats: true) { _ in tick() }
Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in save() }
for sig in [SIGTERM, SIGINT] {
  signal(sig, SIG_IGN)
  let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
  src.setEventHandler { save(); exit(0) }
  src.resume()
  _ = Unmanaged.passRetained(src)
}
RunLoop.main.run()
