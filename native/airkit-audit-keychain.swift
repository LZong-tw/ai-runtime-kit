import Foundation
import Security

private let service = "ai-runtime-kit.audit"

func fail() -> Never {
    FileHandle.standardError.write(Data("AIRKIT_AUDIT_KEYCHAIN_UNAVAILABLE\n".utf8))
    exit(1)
}

do {
    let args = Array(CommandLine.arguments.dropFirst())
    if args.count == 2 && args[0] == "store" {
        let account = args[1]
        var query: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account]
        let value = FileHandle.standardInput.readDataToEndOfFile()
        guard value.count == 32 else { throw NSError(domain: "airkit.audit", code: 1) }
        let storedValue = Data(value.map { String(format: "%02x", $0) }.joined().utf8)
        SecItemDelete(query as CFDictionary)
        var item = query
        item[kSecValueData] = storedValue
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw NSError(domain: "airkit.audit", code: 2) }
    } else if args.count == 2 && args[0] == "read" {
        let account = args[1]
        var query: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account]
        var readQuery = query
        readQuery[kSecReturnData] = true
        var item: CFTypeRef?
        guard SecItemCopyMatching(readQuery as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              data.count == 64 else { throw NSError(domain: "airkit.audit", code: 3) }
        FileHandle.standardOutput.write(data.base64EncodedData())
    } else {
        throw NSError(domain: "airkit.audit", code: 4)
    }
} catch {
    fail()
}
