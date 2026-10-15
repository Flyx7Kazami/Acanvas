import AppKit
import Foundation

// Manual integration helper: snapshot data stays in this process's memory.
// Run with known fixture files, paste into an isolated project, then send restore.
func report(_ value: [String: Any]) {
    let bytes = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(bytes)
    FileHandle.standardOutput.write(Data([10]))
}

let inspect = CommandLine.arguments.contains("--inspect")
let arguments = Array(CommandLine.arguments.dropFirst()).filter { $0 != "--inspect" }
guard arguments.count >= 2, arguments[0] == "--fixture-directory" else {
    report(["event": "aborted", "reason": "fixture_directory_required"])
    exit(1)
}
let directory = URL(fileURLWithPath: arguments[1], isDirectory: true).resolvingSymlinksInPath().standardizedFileURL
let files = arguments.dropFirst(2).map { directory.appendingPathComponent($0).resolvingSymlinksInPath().standardizedFileURL }
guard !files.isEmpty, files.allSatisfy({ file in
    let path = file.path
    var isDirectory: ObjCBool = false
    return path.hasPrefix(directory.path + "/") && FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) && !isDirectory.boolValue
}) else {
    report(["event": "aborted", "reason": "regular_fixture_files_required"])
    exit(1)
}

let pasteboard = NSPasteboard.general
let originalChange = pasteboard.changeCount
let originals = pasteboard.pasteboardItems ?? []
let aggregateTypes = Set(pasteboard.types ?? [])
var preservedTypes = Set<NSPasteboard.PasteboardType>()
var snapshot: [[NSPasteboard.PasteboardType: Data]] = []
for original in originals {
    var item: [NSPasteboard.PasteboardType: Data] = [:]
    guard !original.types.isEmpty else {
        report(["event": "aborted", "reason": "empty_item_snapshot"])
        exit(1)
    }
    for type in original.types {
        guard let data = original.data(forType: type) else {
            report(["event": "aborted", "reason": "incomplete_snapshot"])
            exit(1)
        }
        item[type] = data
        preservedTypes.insert(type)
    }
    snapshot.append(item)
}
var globalFlavors: [NSPasteboard.PasteboardType: Data] = [:]
for type in aggregateTypes {
    guard let data = pasteboard.data(forType: type) else {
        report(["event": "aborted", "reason": "incomplete_global_flavor_snapshot"])
        exit(1)
    }
    globalFlavors[type] = data
}
guard pasteboard.changeCount == originalChange else {
    report(["event": "aborted", "reason": "clipboard_changed_during_snapshot"])
    exit(1)
}
func cloneItems() -> [NSPasteboardItem]? {
    var result: [NSPasteboardItem] = []
    for flavors in snapshot {
        let item = NSPasteboardItem()
        for (type, data) in flavors {
            guard item.setData(data, forType: type) else { return nil }
        }
        result.append(item)
    }
    return result
}
func equivalent(_ board: NSPasteboard) -> Bool {
    let items = board.pasteboardItems ?? []
    guard items.count == snapshot.count, Set(board.types ?? []) == aggregateTypes else { return false }
    for (item, flavors) in zip(items, snapshot) {
        guard Set(item.types) == Set(flavors.keys) else { return false }
        for (type, data) in flavors { guard item.data(forType: type) == data else { return false } }
    }
    for (type, data) in globalFlavors { guard board.data(forType: type) == data else { return false } }
    return true
}
let privateBoard = NSPasteboard.withUniqueName()
func releasePrivateBoard() { privateBoard.clearContents(); privateBoard.releaseGlobally() }
guard let clone = cloneItems() else {
    releasePrivateBoard()
    report(["event": "aborted", "reason": "snapshot_clone_failed"])
    exit(1)
}
privateBoard.clearContents()
let cloneWritten = clone.isEmpty || privateBoard.writeObjects(clone)
var explicitlyWriteGlobalFlavors = false
if !cloneWritten || !equivalent(privateBoard) {
    // Test a native global-flavor representation on the private board first.
    privateBoard.addTypes(Array(globalFlavors.keys), owner: nil)
    var globalWritten = true
    for (type, data) in globalFlavors { globalWritten = privateBoard.setData(data, forType: type) && globalWritten }
    guard globalWritten && equivalent(privateBoard) else {
        releasePrivateBoard()
        report(["event": "aborted", "reason": "snapshot_representation_not_equivalent"])
        exit(1)
    }
    explicitlyWriteGlobalFlavors = true
}
releasePrivateBoard()
if inspect {
    report(["event": "inspected", "snapshotComplete": true, "privateCloneEquivalent": true, "explicitGlobalFlavors": explicitlyWriteGlobalFlavors, "snapshotItems": snapshot.count, "snapshotTypes": aggregateTypes.count])
    exit(0)
}

let nativeItems = files.map { file -> NSPasteboardItem in
    let item = NSPasteboardItem()
    item.setString(file.absoluteString, forType: .fileURL)
    return item
}
guard pasteboard.changeCount == originalChange else {
    report(["event": "aborted", "reason": "clipboard_changed_before_clear"])
    exit(1)
}
let clearedChange = pasteboard.clearContents()
guard pasteboard.changeCount == clearedChange else {
    report(["event": "aborted", "reason": "clipboard_changed_before_write"])
    exit(1)
}
let written = pasteboard.writeObjects(nativeItems)
let ownedChange = pasteboard.changeCount
var finished = false
func restore() {
    guard !finished else { return }
    finished = true
    guard pasteboard.changeCount == ownedChange else {
        report(["event": "restored", "restored": false, "reason": "clipboard_changed"])
        return
    }
    let restoringChange = pasteboard.clearContents()
    guard pasteboard.changeCount == restoringChange else {
        report(["event": "restored", "restored": false, "reason": "clipboard_changed_during_restore"])
        return
    }
    guard let items = cloneItems() else {
        report(["event": "restored", "restored": false, "reason": "snapshot_clone_failed"])
        return
    }
    var restored = items.isEmpty || pasteboard.writeObjects(items)
    if explicitlyWriteGlobalFlavors {
        pasteboard.addTypes(Array(globalFlavors.keys), owner: nil)
        for (type, data) in globalFlavors { restored = pasteboard.setData(data, forType: type) && restored }
    }
    report(["event": "restored", "restored": restored && equivalent(pasteboard), "snapshotItems": snapshot.count, "snapshotTypes": aggregateTypes.count])
}
guard written else {
    restore()
    exit(1)
}
report(["event": "ready", "fixtureFiles": files.count, "snapshotComplete": true, "privateCloneEquivalent": true, "snapshotItems": snapshot.count, "snapshotTypes": aggregateTypes.count, "writtenTypes": ["public.file-url"]])

FileHandle.standardInput.readabilityHandler = { handle in
    let data = handle.availableData
    if data.isEmpty || String(data: data, encoding: .utf8)?.contains("restore") == true {
        DispatchQueue.main.async { restore() }
    }
}
var signals: [DispatchSourceSignal] = []
for number in [SIGINT, SIGTERM, SIGHUP] {
    signal(number, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
    source.setEventHandler { restore() }
    source.resume()
    signals.append(source)
}
let timeout = Timer.scheduledTimer(withTimeInterval: 120, repeats: false) { _ in restore() }
while !finished { RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.1)) }
timeout.invalidate()
FileHandle.standardInput.readabilityHandler = nil
