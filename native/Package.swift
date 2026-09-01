// swift-tools-version: 6.0
//
// MyMoneyKit — the money rules of the MyMoney PWA, restated in Swift.
//
// A LIBRARY AND TESTS ONLY, on purpose. Phase 0 of the native port is where
// correctness is won: every rule in SPEC §6 that a wrong answer would violate
// lives here, driven by the same oracle fixtures (../tools/oracle/cases) that
// the TypeScript build is held to. There is no app target and no UI, because
// a screen cannot be proved right and this can.
//
// No dependencies. Not an aesthetic choice: this package is the thing that
// decides whether a number is correct, and a transitive dependency is a place
// where somebody else decides that instead.
import PackageDescription

let package = Package(
    name: "MyMoneyKit",
    // macOS 14 / iOS 17 is the floor the app targets. CryptoKit (SHA-256) and
    // Swift 6 concurrency are both far below it.
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "MyMoneyKit", targets: ["MyMoneyKit"]),
    ],
    targets: [
        .target(
            name: "MyMoneyKit",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "MyMoneyKitTests",
            dependencies: ["MyMoneyKit"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
