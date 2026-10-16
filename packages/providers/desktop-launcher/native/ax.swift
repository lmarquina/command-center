// Minimal Accessibility driver for Claude Desktop (Electron). No coordinates, no OCR.
// Build: swiftc -O -o scripts/ax src/desktopAX/ax.swift
// Usage:
//   ax dump [maxDepth] [rootQuery]       print AX tree (role | name | value | dom id/classes)
//   ax find <role> <nameSubstring>       list matching elements
//   ax press <role> <nameSubstring> [n]  AXPress the n-th match (default 0)
//   ax setvalue <role> <nameSubstring> <text>   set AXValue (e.g. composer) and focus it
//   ax text [maxChars]                   concatenated static text of the main window (transcript read)
import Cocoa
import ApplicationServices

let bundleId = ProcessInfo.processInfo.environment["AX_BUNDLE"] ?? "com.anthropic.claudefordesktop"
guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
  fputs("Claude Desktop not running\n", stderr); exit(2)
}
let axApp = AXUIElementCreateApplication(app.processIdentifier)
// Electron only builds its web AX tree when an AT announces itself.
AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue)
AXUIElementSetAttributeValue(axApp, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
usleep(300_000)

func attr(_ e: AXUIElement, _ a: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(e, a as CFString, &v) == .success ? v : nil
}
func str(_ e: AXUIElement, _ a: String) -> String {
  if let s = attr(e, a) as? String { return s }
  return ""
}
func children(_ e: AXUIElement) -> [AXUIElement] { (attr(e, "AXChildren") as? [AXUIElement]) ?? [] }
func name(_ e: AXUIElement) -> String {
  for a in ["AXTitle", "AXDescription", "AXLabel"] { let s = str(e, a); if !s.isEmpty { return s } }
  return ""
}
func oneLine(_ s: String, _ n: Int) -> String {
  let t = s.replacingOccurrences(of: "\n", with: " ⏎ ")
  return t.count > n ? String(t.prefix(n)) + "…" : t
}
func describe(_ e: AXUIElement) -> String {
  let role = str(e, "AXRole"), sub = str(e, "AXSubrole")
  let val = (attr(e, "AXValue") as? String) ?? ""
  let dom = str(e, "AXDOMIdentifier").isEmpty ? str(e, "AXIdentifier") : str(e, "AXDOMIdentifier")
  let url = (attr(e, "AXURL") as? URL)?.absoluteString ?? ""
  let cls = ((attr(e, "AXDOMClassList") as? [String]) ?? []).filter { !$0.contains("_") && $0.count < 30 }.prefix(3).joined(separator: ".")
  var parts = [role + (sub.isEmpty ? "" : "/" + sub)]
  let n = name(e); if !n.isEmpty { parts.append("\"\(oneLine(n, 90))\"") }
  if !val.isEmpty { parts.append("= \(oneLine(val, 90))") }
  if !dom.isEmpty { parts.append("#\(dom)") }
  if !url.isEmpty { parts.append("<\(oneLine(url, 80))>") }
  if !cls.isEmpty { parts.append(".\(cls)") }
  if let en = attr(e, "AXEnabled") as? Bool, !en { parts.append("[disabled]") }
  return parts.joined(separator: " ")
}
func windows() -> [AXUIElement] { (attr(axApp, "AXWindows") as? [AXUIElement]) ?? [] }
func walk(_ e: AXUIElement, _ depth: Int, _ max: Int, _ visit: (AXUIElement, Int) -> Void) {
  visit(e, depth)
  if depth >= max { return }
  for c in children(e) { walk(c, depth + 1, max, visit) }
}
func findAll(role: String, nameSub: String) -> [AXUIElement] {
  var out: [AXUIElement] = []
  for w in windows() {
    walk(w, 0, 60) { e, _ in
      let r = str(e, "AXRole")
      let hay = name(e) + " " + ((attr(e, "AXValue") as? String) ?? "") + " " + str(e, "AXPlaceholderValue")
      if (role == "*" || r == role) && (nameSub.isEmpty || hay.localizedCaseInsensitiveContains(nameSub)) { out.append(e) }
    }
  }
  return out
}

let args = Array(CommandLine.arguments.dropFirst())
switch args.first ?? "dump" {
case "dump":
  let max = args.count > 1 ? Int(args[1]) ?? 40 : 40
  for w in windows() {
    walk(w, 0, max) { e, d in
      let line = describe(e)
      if line.hasPrefix("AXGroup") && !line.contains("\"") && !line.contains("#") && !line.contains("=") { return } // skip anonymous groups
      print(String(repeating: "  ", count: min(d, 30)) + line)
    }
  }
case "find":
  for (i, e) in findAll(role: args[1], nameSub: args.count > 2 ? args[2] : "").enumerated() { print("[\(i)] \(describe(e))") }
case "press":
  let m = findAll(role: args[1], nameSub: args[2]); let i = args.count > 3 ? Int(args[3]) ?? 0 : 0
  guard i < m.count else { fputs("no match\n", stderr); exit(1) }
  let r = AXUIElementPerformAction(m[i], kAXPressAction as CFString)
  print("press \(describe(m[i])) -> \(r.rawValue)")
case "pressid":
  // AXPress the first element whose DOM id contains the substring (stable ids like "…-browse").
  var hit: AXUIElement?
  for w in windows() { walk(w, 0, 80) { e, _ in if hit == nil && str(e, "AXDOMIdentifier").contains(args[1]) { hit = e } } }
  guard let e = hit else { fputs("no match\n", stderr); exit(1) }
  print("pressid \(describe(e)) -> \(AXUIElementPerformAction(e, kAXPressAction as CFString).rawValue)")
case "pressexact":
  // Fail closed: exactly one element of this role whose name equals the argument.
  let m = findAll(role: args[1], nameSub: args[2]).filter { name($0) == args[2] }
  guard m.count == 1 else { fputs("expected 1 exact match, found \(m.count)\n", stderr); exit(1) }
  print("pressexact \(describe(m[0])) -> \(AXUIElementPerformAction(m[0], kAXPressAction as CFString).rawValue)")
case "value":
  // Full (untruncated) AXValue of the first match.
  guard let e = findAll(role: args[1], nameSub: args[2]).first else { fputs("no match\n", stderr); exit(1) }
  print((attr(e, "AXValue") as? String) ?? "")
case "url":
  // URL of the claude.ai web area (the page Desktop is showing).
  var u = ""
  for w in windows() { walk(w, 0, 12) { e, _ in if u.isEmpty && str(e, "AXRole") == "AXWebArea", let x = (attr(e, "AXURL") as? URL)?.absoluteString, x.hasPrefix("https://") { u = x } } }
  guard !u.isEmpty else { fputs("no web area\n", stderr); exit(1) }
  print(u)
case "setvalue":
  let m = findAll(role: args[1], nameSub: args[2])
  guard let e = m.first else { fputs("no match\n", stderr); exit(1) }
  AXUIElementSetAttributeValue(e, kAXFocusedAttribute as CFString, kCFBooleanTrue)
  let r = AXUIElementSetAttributeValue(e, kAXValueAttribute as CFString, args[3] as CFString)
  print("setvalue \(describe(e)) -> \(r.rawValue)")
case "text":
  let max = args.count > 1 ? Int(args[1]) ?? 4000 : 4000
  var buf = ""
  for w in windows() { walk(w, 0, 80) { e, _ in if str(e, "AXRole") == "AXStaticText", let v = attr(e, "AXValue") as? String, !v.isEmpty { buf += v + "\n" } } }
  print(String(buf.suffix(max)))
default:
  fputs("unknown command\n", stderr); exit(1)
}
