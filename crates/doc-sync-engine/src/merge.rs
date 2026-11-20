//! Three-way merge of Markdown bodies by line (docs/design.md §6.6).
//!
//! `base` is the body both sides started from. Places changed on one side only take that side's
//! lines; places both sides changed the same way take that change; places both sides changed
//! differently become a [`Chunk::Conflict`] for the user to decide. Lines keep their `\n`, so
//! joining the chunks gives the merged body byte for byte.

/// A piece of a merged body, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Chunk {
    /// Lines the merge settled.
    Same(String),
    /// A place both sides changed differently: the local lines and Backlog's lines there.
    /// Either may be empty (one side deleted the lines).
    Conflict { local: String, remote: String },
}

/// Merges `local` and `remote`, which both started from `base`.
pub fn merge(base: &str, local: &str, remote: &str) -> Vec<Chunk> {
    let b = lines(base);
    let l = lines(local);
    let r = lines(remote);
    let to_local = matches(&b, &l);
    let to_remote = matches(&b, &r);

    let mut out = Vec::new();
    let (mut i, mut j, mut k) = (0, 0, 0);
    loop {
        // The next base line that both sides kept. Matches are increasing, so the lines before
        // it on each side form one region.
        let anchor = (i..b.len()).find_map(|p| Some((p, to_local[p]?, to_remote[p]?)));
        let (p, jl, kr) = anchor.unwrap_or((b.len(), l.len(), r.len()));
        merge_region(&b[i..p], &l[j..jl], &r[k..kr], &mut out);
        if anchor.is_none() {
            break;
        }
        push_same(&mut out, &[b[p]]);
        (i, j, k) = (p + 1, jl + 1, kr + 1);
    }
    out
}

/// The merged body when no place needs a decision.
pub fn clean(chunks: &[Chunk]) -> Option<String> {
    chunks
        .iter()
        .try_fold(String::new(), |mut acc, chunk| match chunk {
            Chunk::Same(text) => {
                acc.push_str(text);
                Some(acc)
            }
            Chunk::Conflict { .. } => None,
        })
}

fn merge_region(base: &[&str], local: &[&str], remote: &[&str], out: &mut Vec<Chunk>) {
    if local == base || local == remote {
        push_same(out, remote);
    } else if remote == base {
        push_same(out, local);
    } else {
        out.push(Chunk::Conflict {
            local: local.concat(),
            remote: remote.concat(),
        });
    }
}

fn push_same(out: &mut Vec<Chunk>, lines: &[&str]) {
    if lines.is_empty() {
        return;
    }
    if let Some(Chunk::Same(text)) = out.last_mut() {
        text.push_str(&lines.concat());
    } else {
        out.push(Chunk::Same(lines.concat()));
    }
}

/// Lines with their line endings, so that concatenating them gives the text back.
fn lines(text: &str) -> Vec<&str> {
    text.split_inclusive('\n').collect()
}

/// For each line of `a`, the line of `b` it is matched to by a longest common subsequence.
fn matches(a: &[&str], b: &[&str]) -> Vec<Option<usize>> {
    let mut out = vec![None; a.len()];
    // Edits are usually local: match the common start and end directly, and run the quadratic
    // LCS only on what lies between.
    let prefix = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    let suffix = a[prefix..]
        .iter()
        .rev()
        .zip(b[prefix..].iter().rev())
        .take_while(|(x, y)| x == y)
        .count();
    for (n, slot) in out.iter_mut().enumerate().take(prefix) {
        *slot = Some(n);
    }
    for n in 0..suffix {
        out[a.len() - 1 - n] = Some(b.len() - 1 - n);
    }
    let (a_mid, b_mid) = (&a[prefix..a.len() - suffix], &b[prefix..b.len() - suffix]);
    let (n, m) = (a_mid.len(), b_mid.len());
    // lcs[x][y] = LCS length of a_mid[x..] and b_mid[y..]
    let mut lcs = vec![vec![0u32; m + 1]; n + 1];
    for x in (0..n).rev() {
        for y in (0..m).rev() {
            lcs[x][y] = if a_mid[x] == b_mid[y] {
                lcs[x + 1][y + 1] + 1
            } else {
                lcs[x + 1][y].max(lcs[x][y + 1])
            };
        }
    }
    let (mut x, mut y) = (0, 0);
    while x < n && y < m {
        if a_mid[x] == b_mid[y] {
            out[prefix + x] = Some(prefix + y);
            x += 1;
            y += 1;
        } else if lcs[x + 1][y] >= lcs[x][y + 1] {
            x += 1;
        } else {
            y += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn same(text: &str) -> Chunk {
        Chunk::Same(text.into())
    }

    fn conflict(local: &str, remote: &str) -> Chunk {
        Chunk::Conflict {
            local: local.into(),
            remote: remote.into(),
        }
    }

    const BASE: &str = "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n";

    #[test]
    fn edits_to_different_paragraphs_merge() {
        let local = BASE.replace("First paragraph.", "First paragraph, edited here.");
        let remote = BASE.replace("Third paragraph.", "Third paragraph, edited on Backlog.");
        let chunks = merge(BASE, &local, &remote);
        assert_eq!(
            clean(&chunks).as_deref(),
            Some(
                "# Title\n\nFirst paragraph, edited here.\n\nSecond paragraph.\n\nThird paragraph, edited on Backlog.\n"
            )
        );
    }

    #[test]
    fn additions_in_different_places_merge() {
        let local = format!("{BASE}\nAdded at the end here.\n");
        let remote = BASE.replace("# Title\n", "# Title\n\nAdded at the top on Backlog.\n");
        assert_eq!(
            clean(&merge(BASE, &local, &remote)),
            Some("# Title\n\nAdded at the top on Backlog.\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n\nAdded at the end here.\n".to_string())
        );
    }

    #[test]
    fn the_same_paragraph_changed_differently_conflicts() {
        let local = BASE.replace("Second paragraph.", "Second, mine.");
        let remote = BASE.replace("Second paragraph.", "Second, theirs.");
        assert_eq!(
            merge(BASE, &local, &remote),
            [
                same("# Title\n\nFirst paragraph.\n\n"),
                conflict("Second, mine.\n", "Second, theirs.\n"),
                same("\nThird paragraph.\n"),
            ]
        );
        assert_eq!(clean(&merge(BASE, &local, &remote)), None);
    }

    #[test]
    fn the_same_change_on_both_sides_is_taken_once() {
        let both = BASE.replace("Second paragraph.", "Second, fixed.");
        assert_eq!(clean(&merge(BASE, &both, &both)), Some(both));
    }

    #[test]
    fn a_deletion_merges_with_an_edit_elsewhere() {
        let local = BASE.replace("Second paragraph.\n\n", "");
        let remote = BASE.replace("First paragraph.", "First, theirs.");
        assert_eq!(
            clean(&merge(BASE, &local, &remote)).as_deref(),
            Some("# Title\n\nFirst, theirs.\n\nThird paragraph.\n")
        );
    }

    #[test]
    fn deleting_what_the_other_side_edited_conflicts() {
        let local = BASE.replace("Second paragraph.\n", "");
        let remote = BASE.replace("Second paragraph.", "Second, theirs.");
        assert!(
            merge(BASE, &local, &remote)
                .iter()
                .any(|c| matches!(c, Chunk::Conflict { local, remote } if local.is_empty() && remote == "Second, theirs.\n"))
        );
    }

    #[test]
    fn both_appending_at_the_end_conflicts() {
        let local = format!("{BASE}mine\n");
        let remote = format!("{BASE}theirs\n");
        assert_eq!(
            merge(BASE, &local, &remote),
            [same(BASE), conflict("mine\n", "theirs\n")]
        );
    }

    #[test]
    fn one_side_unchanged_takes_the_other() {
        let local = BASE.replace("First", "Changed");
        assert_eq!(clean(&merge(BASE, &local, BASE)), Some(local.clone()));
        assert_eq!(clean(&merge(BASE, BASE, &local)), Some(local));
    }

    #[test]
    fn a_missing_final_newline_is_kept() {
        assert_eq!(
            clean(&merge("a\nb", "a\nb", "a\nb")).as_deref(),
            Some("a\nb")
        );
        assert_eq!(
            clean(&merge("a\nb", "x\nb", "a\nb")).as_deref(),
            Some("x\nb")
        );
        assert_eq!(clean(&merge("", "x", "")).as_deref(), Some("x"));
    }

    #[test]
    fn chunks_join_back_to_each_side() {
        let local = BASE.replace("Second paragraph.", "Second, mine.") + "tail\n";
        let remote = BASE
            .replace("Second paragraph.", "Second, theirs.")
            .replace("# Title", "# New title");
        let chunks = merge(BASE, &local, &remote);
        let side = |pick_local: bool| -> String {
            chunks
                .iter()
                .map(|c| match c {
                    Chunk::Same(t) => t.as_str(),
                    Chunk::Conflict { local, remote } => {
                        if pick_local {
                            local
                        } else {
                            remote
                        }
                    }
                })
                .collect()
        };
        // Taking one side at every conflict gives that side's text with the other's
        // non-conflicting changes merged in.
        assert_eq!(side(true), local.replace("# Title", "# New title"));
        assert_eq!(side(false), remote.clone() + "tail\n");
    }
}
