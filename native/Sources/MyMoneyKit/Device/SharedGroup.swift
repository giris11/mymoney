// The directory an app and its widget both see, found the same way in both.
//
// AN APP GROUP IDENTIFIER IS A BUILD-TIME FACT, and it has to be written in
// three places that must agree: the app's entitlements, the widget's
// entitlements, and the Swift that asks for the container. Three spellings of
// one string is a bug that looks like "the widget is empty" and reads like
// nothing at all.
//
// So it is declared ONCE, as the `MYMONEY_APP_GROUP` build setting in the Xcode
// project, and reaches all three from there: the two entitlements files
// interpolate it, and each bundle carries it in its own Info.plist under
// `MyMoneyAppGroup`. This function reads it back out of whichever bundle is
// asking. The app and the widget therefore cannot disagree about it, and a
// change is one line in one place.
//
// NIL IS AN ORDINARY ANSWER. A build signed without the capability -- which is
// this project's device build, until the App Groups capability is added in
// Xcode by somebody signed in to the developer account -- gets nil here, writes
// no snapshot, and shows a widget that says to open the app. Nothing crashes
// and no figure is invented.
import Foundation

public enum SharedGroup {

    /// The Info.plist key each bundle carries the identifier under.
    public static let infoKey = "MyMoneyAppGroup"

    /// The identifier this bundle was built with, or nil when it was built
    /// without one.
    public static func identifier(in bundle: Bundle = .main) -> String? {
        guard let value = bundle.object(forInfoDictionaryKey: infoKey) as? String,
            !value.isEmpty,
            // An unexpanded build setting -- "$(MYMONEY_APP_GROUP)" -- means
            // the setting was not defined for this target. Treated as absent
            // rather than passed to the system, which would answer nil anyway
            // and leave nothing to diagnose.
            !value.hasPrefix("$(")
        else { return nil }
        return value
    }

    /// The shared container, or nil when this build has no group or is not
    /// entitled to the one it names.
    public static func containerURL(in bundle: Bundle = .main) -> URL? {
        guard let identifier = identifier(in: bundle) else { return nil }
        return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: identifier)
    }
}
