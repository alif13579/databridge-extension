// bt-dial-cli (macOS) — paired button/feature phone-e Bluetooth RFCOMM diye
// ATD dial. DataBridge bt-dial/server.js (mac backend) theke call hoy, chaile
// terminal thekeo chalano jay.
//
//   List paired :  ./bt-dial-cli --list
//   Dial        :  ./bt-dial-cli --mac AA:BB:CC:DD:EE:FF --dial 01XXXXXXXXX [--channel 3] [--timeout 20]
//
// SDP theke RFCOMM channel ber kore (HFP-AG 0x111F → SerialPort 0x1101),
// --channel dile SDP skip kore direct setai khole. stdout-e JSON, exit 0/1.
//
// Build: swiftc -O -o bt-dial-cli bt-dial-cli.swift -framework IOBluetooth
import Foundation
import IOBluetooth

func jsonOut(_ obj: [String: Any], exitCode: Int32) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
       let s = String(data: data, encoding: .utf8) {
        print(s)
    } else {
        print("{\"ok\":false,\"error\":\"json encode failed\"}")
    }
    exit(exitCode)
}

func fail(_ msg: String) -> Never {
    jsonOut(["ok": false, "error": msg], exitCode: 1)
}

// ---- arg parse ----
var macArg = ""
var dialArg = ""
var channelArg: UInt8? = nil
var timeoutArg = 20.0
var listMode = false
var i = 1
let args = CommandLine.arguments
while i < args.count {
    switch args[i] {
    case "--mac": i += 1; if (i < args.count) { macArg = args[i] }
    case "--dial": i += 1; if (i < args.count) { dialArg = args[i] }
    case "--channel": i += 1; if (i < args.count) { channelArg = UInt8(args[i]) }
    case "--timeout": i += 1; if (i < args.count) { timeoutArg = Double(args[i]) ?? 20.0 }
    case "--list": listMode = true
    case "--help", "-h":
        print("Usage: bt-dial-cli --list | --mac AA:BB:CC:DD:EE:FF --dial 01XXXXXXXXX [--channel N] [--timeout S]")
        exit(0)
    default: break
    }
    i += 1
}

// ---- --list: paired devices ----
if (listMode) {
    let paired = (IOBluetoothDevice.pairedDevices() as? [IOBluetoothDevice]) ?? []
    let arr: [[String: String]] = paired.map { d in
        ["name": d.name ?? "", "mac": (d.addressString ?? "").uppercased()]
    }
    jsonOut(["ok": true, "paired": arr], exitCode: 0)
}

if (macArg.isEmpty || dialArg.isEmpty) {
    fail("usage: --mac AA:BB:CC:DD:EE:FF --dial 01XXXXXXXXX [--channel N]")
}
let macNorm = macArg.replacingOccurrences(of: "-", with: ":").uppercased()
let digits = dialArg.filter { $0.isNumber || $0 == "+" }
if (digits.count < 7 || digits.count > 16) {
    fail("invalid phone number")
}

guard let device = IOBluetoothDevice(addressString: macNorm) else {
    fail("no such bluetooth device (pair first in System Settings)")
}

// ---- SDP: RFCOMM channel khojo (HFP-AG → SerialPort) ----
final class SDPWait: NSObject, IOBluetoothDeviceAsyncCallbacks {
    var done = false
    var status: IOReturn = kIOReturnSuccess
    func sdpQueryComplete(_ device: IOBluetoothDevice!, status: IOReturn) {
        self.status = status
        self.done = true
    }
    // Unused callbacks (protocol conformance-er jonno khali):
    func connectionComplete(_ device: IOBluetoothDevice!, status: IOReturn) {}
    func remoteNameRequestComplete(_ device: IOBluetoothDevice!, status: IOReturn) {}
}

func waitUntil(_ deadline: Date, _ cond: () -> Bool) {
    while (!cond() && Date() < deadline) {
        RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.2))
    }
}

func discoverChannel(_ device: IOBluetoothDevice, timeout: Double) -> UInt8? {
    let waiter = SDPWait()
    let deadline = Date(timeIntervalSinceNow: timeout)
    var kr = device.performSDPQuery(waiter)
    if (kr != kIOReturnSuccess) { return nil }
    waitUntil(deadline) { waiter.done }
    if (!waiter.done || waiter.status != kIOReturnSuccess) { return nil }
    // HFP Audio Gateway (0x111F) age, tarpor Serial Port (0x1101).
    for uuid16: BluetoothSDPUUID16 in [0x111F, 0x1101] {
        let uuid = IOBluetoothSDPUUID(uuid16: uuid16)
        if let rec = device.getServiceRecord(for: uuid) {
            var ch: BluetoothRFCOMMChannelID = 0
            kr = rec.getRFCOMMChannelID(&ch)
            if (kr == kIOReturnSuccess && ch > 0) { return ch }
        }
    }
    return nil
}

// ---- RFCOMM open + ATD ----
final class DialSession: NSObject, IOBluetoothRFCOMMChannelDelegate {
    var channel: IOBluetoothRFCOMMChannel? = nil
    var opened = false
    var openStatus: IOReturn = kIOReturnSuccess
    var verdict: String? = nil
    var rxBuffer = ""
    func rfcommChannelOpenComplete(_ rfcommChannel: IOBluetoothRFCOMMChannel!, status error: IOReturn) {
        self.channel = rfcommChannel
        self.openStatus = error
        self.opened = true
    }
    func rfcommChannelData(_ rfcommChannel: IOBluetoothRFCOMMChannel!, data dataPointer: UnsafeMutableRawPointer!, length dataLength: Int) {
        let data = Data(bytes: dataPointer, count: dataLength)
        if let s = String(data: data, encoding: .utf8) {
            rxBuffer += s
            let upper = rxBuffer.uppercased()
            if (upper.range(of: "(^|\r|\n)OK(\r|\n|$)", options: .regularExpression) != nil) {
                verdict = "OK"
            } else if (upper.contains("ERROR")) {
                verdict = String(rxBuffer.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80))
            }
        }
    }
    func rfcommChannelClosed(_ rfcommChannel: IOBluetoothRFCOMMChannel!) {
        if (verdict == nil) { verdict = "closed" }
    }
}

let session = DialSession()
let overallDeadline = Date(timeIntervalSinceNow: timeoutArg)

var channelID: BluetoothRFCOMMChannelID = 0
if let forced = channelArg {
    channelID = forced
} else if let found = discoverChannel(device, timeout: min(12.0, timeoutArg / 2.0)) {
    channelID = found
} else {
    fail("RFCOMM channel not found (HFP/Serial service missing? phone paired + in range?)")
}

var ch: IOBluetoothRFCOMMChannel? = nil
let openRes = device.openRFCOMMChannelAsync(&ch, withChannelID: channelID, delegate: session)
if (openRes != kIOReturnSuccess) {
    fail("RFCOMM open failed to start (\(openRes))")
}
waitUntil(overallDeadline) { session.opened }
if (!session.opened) { fail("RFCOMM open timeout (phone in range?)") }
if (session.openStatus != kIOReturnSuccess) { fail("RFCOMM open failed (\(session.openStatus))") }
// Voice call dial — ';' charai phone data-call vabe.
let cmd = "ATD\(digits);\r"
cmd.withCString { ptr in
    _ = session.channel?.writeSync(UnsafeMutableRawPointer(mutating: ptr), length: UInt16(cmd.utf8.count))
}
waitUntil(overallDeadline) { session.verdict != nil }
if (session.verdict == "OK") {
    jsonOut(["ok": true, "channel": Int(channelID)], exitCode: 0)
} else {
    fail("phone rejected dial (\(session.verdict ?? "no verdict"))")
}
