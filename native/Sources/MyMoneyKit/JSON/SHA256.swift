// SHA-256 of the canonical text.
//
// WHY CRYPTOKIT AND NOT A HAND-WRITTEN ONE. src/backup/canonical.ts had to
// write its own, and its comment says why: WebCrypto is secure-context only,
// and the promised route onto the owner's iPhone is http://192.168.1.x over
// the LAN, where `crypto.subtle` simply does not exist. None of that applies
// here. CryptoKit is present on every platform this package targets, is
// constant-time and audited, and -- the load-bearing part -- SHA-256 is fixed
// by FIPS 180-4, so it produces the identical digest for the identical bytes
// as the hand-written JavaScript. That equality is the entire point: the hash
// exists to let a Swift import prove it reproduced a browser's export.
//
// A cheap non-cryptographic hash was rejected there and is rejected here for
// the same reason: this figure asserts that two copies of a financial history
// are the same data, and a 32-bit hash collides by accident at that job.
import CryptoKit
import Foundation

public enum ContentHash {
    /// SHA-256 of a string's UTF-8 bytes, lowercase hex -- the same contract as
    /// `sha256Hex` in src/backup/canonical.ts.
    public static func sha256Hex(_ text: String) -> String {
        sha256Hex(Data(text.utf8))
    }

    public static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data)
            .map { String(format: "%02x", $0) }
            .joined()
    }
}
