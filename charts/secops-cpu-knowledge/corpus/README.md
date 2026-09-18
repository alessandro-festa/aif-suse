# Seed corpus

Seven documents, embedded into Qdrant by the ingest Job at install time. They are what the
researcher agents retrieve and what the human opens in the Qdrant dashboard when they want to
read the advisory a remediation was justified by.

Two of them — `base-image-distro-cves` and `runbook-rebase-to-application-collection` — cover the
profile's own demo target, and were added after a live run in which they were missing. The
researchers were asked about base-OS CVEs in `nginx`, found nothing on the subject, and cited
Log4Shell instead: the most prominent document present, and the wrong one. A briefing that says
"cite the document id you used" is an instruction to cite *something*, so a corpus with no
coverage of the target does not produce "I found nothing" — it produces a confident citation of
whatever is nearest. Keep this directory's coverage aligned with what the profile actually
demonstrates, or the retrieval step will look like it worked while being entirely wrong.

## Read this before treating any of it as advisory data

**The CVE identifiers and the `suse_cve_page` URLs are real and verifiable.** They follow SUSE's
stable per-CVE URL pattern, so a human can open them and check the agent against the source.

**The advisory bodies are illustrative.** Each carries `"illustrative": true` and a
`fixed_version` that is a plausible shape, not a lookup from SUSE's published data. They exist so
the retrieval path has something with the right structure to retrieve. Do not quote a
`fixed_version` from this directory as though it came from SUSE.

That distinction matters more here than in most demos, because the whole point of the profile is
that a human can retrieve what the agent cited and judge it. A corpus that silently mixed real
and invented advisory content would break exactly the property being demonstrated.

## For a real deployment

Replace this directory. The corpus should be ingested from SUSE's published advisory data —
`updates.suse.com`, `scc.suse.com`, and the per-CVE pages — which the sandbox policy's
`suse_platform` and `vulnerability_sources` groups already permit as read-only egress. The ingest
Job's script does not care where the documents come from; it reads whatever JSON is mounted.

## Format

One JSON object per file. The ingest script reads `title` and `text` to build the embedding
input, and stores everything else as the point payload — so any field added here shows up in the
Qdrant dashboard and in what the agents can cite.
