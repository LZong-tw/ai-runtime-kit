import Foundation
import Security
import LocalAuthentication

private let label = "reveal-authorizer-v1"
private let tag = label.data(using: .utf8)!

enum HelperError: Error {
    case invalidArguments
    case keyUnavailable
    case operationFailed
}

func fail() -> Never {
    FileHandle.standardError.write(Data("AIRKIT_AUDIT_REVEAL_UNAVAILABLE\n".utf8))
    exit(1)
}

func privateKey() throws -> SecKey {
    let query: [CFString: Any] = [
        kSecClass: kSecClassKey,
        kSecAttrApplicationTag: tag,
        kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
        kSecReturnRef: true,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
          let item,
          CFGetTypeID(item) == SecKeyGetTypeID() else { throw HelperError.keyUnavailable }
    return (item as! SecKey)
}

func installKey() throws {
    let access = SecAccessControlCreateWithFlags(
        nil,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        SecAccessControlCreateFlags([.userPresence, .privateKeyUsage]),
        nil
    )
    guard let access else { throw HelperError.operationFailed }
    let attributes: [CFString: Any] = [
        kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeySizeInBits: 256,
        kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
        kSecPrivateKeyAttrs: [
            kSecAttrIsPermanent: true,
            kSecAttrApplicationTag: tag,
            kSecAttrAccessControl: access,
        ],
    ]
    var error: Unmanaged<CFError>?
    guard SecKeyCreateRandomKey(attributes as CFDictionary, &error) != nil else { throw HelperError.operationFailed }
}

func publicKey() throws {
    let key = try privateKey()
    guard let pub = SecKeyCopyPublicKey(key) else { throw HelperError.operationFailed }
    var keyError: Unmanaged<CFError>?
    guard let data = SecKeyCopyExternalRepresentation(pub, &keyError) as Data? else { throw HelperError.operationFailed }
    FileHandle.standardOutput.write(data.base64EncodedData())
}

func sign() throws {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard !input.isEmpty else { throw HelperError.invalidArguments }
    let key = try privateKey()
    var error: Unmanaged<CFError>?
    guard let signature = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, input as CFData, &error) as Data? else { throw HelperError.operationFailed }
    FileHandle.standardOutput.write(signature.base64EncodedData())
}

let arguments = Array(CommandLine.arguments.dropFirst())
do {
    switch arguments {
    case ["install-key"]:
        try installKey()
    case ["public-key"]:
        try publicKey()
    case ["sign", "--nonce-stdin"]:
        try sign()
    default:
        throw HelperError.invalidArguments
    }
} catch {
    fail()
}
