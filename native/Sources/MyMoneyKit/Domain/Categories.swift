// The category tree, ported from src/domain/categories.ts.
//
// Two functions the money rules depend on, and both are about ROLLUP: a
// budget covers its categories plus everything beneath them (D16), and a
// top-level report row is the sum of a whole subtree. Get the tree walk wrong
// and a budget silently stops counting a subcategory the owner files half
// their groceries under.
//
// EVERY WALK HAS A CYCLE GUARD. The data model cannot express a cycle (the
// save path refuses one) but a backup file is just bytes, and a corrupt or
// hand-edited parent link that pointed a category at its own descendant would
// hang the app rather than show a wrong number. A guard is cheaper than a
// hang, and both walks here already needed a `seen` set for other reasons.
import Foundation

/// The minimum a category has to be for the tree walks: an id and a parent.
/// A protocol rather than the concrete `Category` because the oracle's
/// `categories.descendantIds` cases state ONLY these two fields, and padding
/// them out into a full `Category` would mean inventing a `kind` and a `name`
/// the case never claimed -- the fixture would then be testing the padding.
public protocol CategoryTreeNode {
    var id: String { get }
    var parentId: String? { get }
}

/// …plus a name, for the path rendering.
public protocol NamedCategoryTreeNode: CategoryTreeNode {
    var name: String { get }
}

extension Category: NamedCategoryTreeNode {}

public enum Categories {
    /// The given ids PLUS all their descendants (D16).
    ///
    /// An id with no matching category comes back in the set unchanged
    /// (`categories.descendants.unknown-id` pins this). That is deliberate: a
    /// budget naming a category that has since been deleted should keep
    /// matching the transactions still filed under that id, rather than
    /// quietly becoming a budget over nothing.
    public static func descendantIds<C: CategoryTreeNode>(
        _ all: [C], rootIds: some Sequence<String>
    ) -> Set<String> {
        var childrenOf: [String: [String]] = [:]
        for c in all {
            guard let parent = c.parentId, !parent.isEmpty else { continue }
            childrenOf[parent, default: []].append(c.id)
        }
        var out = Set<String>()
        var queue = Array(rootIds)
        while let id = queue.popLast() {
            if out.contains(id) { continue }  // also the cycle guard
            out.insert(id)
            queue.append(contentsOf: childrenOf[id] ?? [])
        }
        return out
    }

    /// "Food › Dining › Coffee" -- the separator is U+203A, matching the
    /// TypeScript character for character. It reaches the UI and the import
    /// warnings, so a different glyph would be a visible difference.
    public static func categoryPathName<C: NamedCategoryTreeNode>(
        _ byId: [String: C], id: String
    ) -> String {
        var parts: [String] = []
        var seen = Set<String>()
        var cur = byId[id]
        while let node = cur, !seen.contains(node.id) {
            seen.insert(node.id)
            parts.insert(node.name, at: 0)
            cur = node.parentId.flatMap { byId[$0] }
        }
        return parts.joined(separator: " \u{203A} ")
    }

    /// The top-level ancestor. An orphan (parent id naming nothing) or a cycle
    /// surfaces as its own root rather than vanishing -- data the owner can see
    /// is always better than data that silently is not counted anywhere.
    static func root<C: CategoryTreeNode>(of category: C, in byId: [String: C]) -> C {
        var cur = category
        var seen: Set<String> = [category.id]
        while let parentId = cur.parentId, let parent = byId[parentId], !seen.contains(parent.id) {
            seen.insert(parent.id)
            cur = parent
        }
        return cur
    }

    /// Where a category belongs in a drill-down under `parentId`:
    /// `.itself` when it IS the parent, `.child(c)` for the direct child of
    /// `parentId` on its ancestor path (the subtree that drill row rolls up),
    /// `nil` when it is outside the parent's subtree entirely.
    enum Bucket<C> {
        case itself
        case child(C)
    }

    static func bucket<C: CategoryTreeNode>(
        of category: C, within parentId: String, in byId: [String: C]
    ) -> Bucket<C>? {
        if category.id == parentId { return .itself }
        var cur: C? = category
        var seen = Set<String>()
        while let node = cur, !seen.contains(node.id) {
            seen.insert(node.id)
            if node.parentId == parentId { return .child(node) }
            cur = node.parentId.flatMap { byId[$0] }
        }
        return nil
    }
}
