// Lists on-screen windows as JSON (id, app, title, bounds) so the recorder can capture one window by id.
import CoreGraphics
import Foundation

let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
let out: [[String: Any]] = list.compactMap { w in
  guard let id = w[kCGWindowNumber as String] as? Int, let b = w[kCGWindowBounds as String] as? [String: CGFloat] else { return nil }
  return ["id": id, "app": w[kCGWindowOwnerName as String] as? String ?? "", "title": w[kCGWindowName as String] as? String ?? "",
          "x": b["X"] ?? 0, "y": b["Y"] ?? 0, "w": b["Width"] ?? 0, "h": b["Height"] ?? 0, "layer": w[kCGWindowLayer as String] as? Int ?? 0]
}
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: out))
