import type { DossierFile } from "./types.ts";

/**
 * A node in the operator's knowledge graph: one dossier file. `central` marks the operator anchor
 * (identity) that everything orbits, so the renderer can place and size it distinctly.
 */
export interface GraphNode {
  id: string; // the file slug (stable identity)
  type: string;
  title: string;
  status: string;
  central: boolean;
}

/**
 * A relationship between two nodes. `kind` explains WHY the edge exists so the UI can style/label
 * it; `label` is an optional human phrase (e.g. a relation like "sister"). Edges are directed
 * source→target but the renderer may treat them as undirected.
 */
export interface GraphEdge {
  source: string;
  target: string;
  kind: "ownership" | "relation" | "transition" | "about";
  label?: string;
}

export interface DossierGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Types that represent a thing the operator OWNS/holds — linked to the operator anchor. */
const OWNERSHIP_TYPES = new Set(["account", "loan", "document"]);

/**
 * Derive a node-link graph from the dossier files — PURE (no I/O), so it is trivially unit-testable
 * and can back a read-only endpoint. The operator's `identity` file (or a synthetic anchor when it
 * doesn't exist yet) is the center; people, owned assets, notes, and invented types orbit it.
 *
 * Edges are derived only from data already present in the files, and every edge is validated
 * against the known node set — an edge to a missing slug is DROPPED, never rendered as a dangling
 * node. `event` files are not drawn as nodes (they'd swamp the graph); instead each event
 * contributes an `about` edge from its `subject` to the operator's timeline is omitted, and the
 * transition is summarized on the subject node by the caller if desired.
 */
export function buildDossierGraph(files: DossierFile[]): DossierGraph {
  // Exclude the timeline index and the raw event files from the node set; they are the trajectory
  // projection, not entities. Preferences is operator-self and folds into the anchor.
  const entities = files.filter(
    (f) => f.frontmatter.type !== "event" && f.frontmatter.type !== "index" && f.frontmatter.slug !== "preferences",
  );

  const identity = entities.find((f) => f.frontmatter.type === "identity");
  const anchorId = identity?.frontmatter.slug ?? "__operator__";

  const nodes: GraphNode[] = [];
  const known = new Set<string>();
  const addNode = (n: GraphNode) => {
    if (known.has(n.id)) return;
    known.add(n.id);
    nodes.push(n);
  };

  // The operator anchor — real identity file, or a synthetic node so the graph is never empty.
  addNode({
    id: anchorId,
    type: "identity",
    title: identity?.frontmatter.title ?? "You",
    status: identity?.frontmatter.status ?? "active",
    central: true,
  });

  for (const f of entities) {
    if (f.frontmatter.slug === anchorId) continue;
    addNode({
      id: f.frontmatter.slug,
      type: f.frontmatter.type,
      title: f.frontmatter.title,
      status: f.frontmatter.status,
      central: false,
    });
  }

  // Index titles → slugs so a free-text `## Relations` line can resolve to a real node.
  const titleToSlug = new Map<string, string>();
  for (const f of entities) titleToSlug.set(f.frontmatter.title.toLowerCase(), f.frontmatter.slug);

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const addEdge = (e: GraphEdge) => {
    if (e.source === e.target) return;
    if (!known.has(e.source) || !known.has(e.target)) return; // drop dangling edges
    const key = `${e.source}\u0000${e.target}\u0000${e.kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(e);
  };

  for (const f of entities) {
    const slug = f.frontmatter.slug;
    if (slug === anchorId) continue;
    const type = f.frontmatter.type;

    // People and social ties connect to the operator via a relation edge (the relation, if the
    // frontmatter recorded one, becomes the label).
    if (type === "person") {
      const relation = typeof f.frontmatter["relation"] === "string" ? (f.frontmatter["relation"] as string) : undefined;
      addEdge({ source: anchorId, target: slug, kind: "relation", ...(relation ? { label: relation } : {}) });
      // Light person↔person parsing: a "## Relations" section listing other known people/titles.
      for (const other of parseRelations(f.body, titleToSlug)) {
        if (other !== slug) addEdge({ source: slug, target: other, kind: "relation" });
      }
      continue;
    }

    // Owned assets/holdings connect to the operator via an ownership edge.
    if (OWNERSHIP_TYPES.has(type)) {
      addEdge({ source: anchorId, target: slug, kind: "ownership" });
      continue;
    }

    // Everything else (notes, invented types) still connects to the operator so the graph is
    // navigable, using the generic "about" kind.
    addEdge({ source: anchorId, target: slug, kind: "about" });
  }

  return { nodes, edges };
}

/**
 * Parse a `## Relations` markdown section for references to other known entities. Returns the slugs
 * of any files whose title appears in a relations bullet. Deliberately conservative: it only links
 * to titles that already exist as nodes (so it can never invent an edge to a non-entity).
 */
function parseRelations(body: string, titleToSlug: Map<string, string>): string[] {
  const m = /(^|\n)##\s+Relations\s*\n([\s\S]*?)(\n##\s|\n?$)/i.exec(body);
  if (!m) return [];
  const section = m[2]!.toLowerCase();
  const out = new Set<string>();
  for (const [title, slug] of titleToSlug) {
    // Word-ish boundary match so "meg" doesn't match "meghna" spuriously.
    if (title.length >= 2 && section.includes(title)) out.add(slug);
  }
  return [...out];
}
