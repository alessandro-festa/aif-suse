#!/usr/bin/env python3
"""Check both figure-0 slides against the rules that define them.

    python3 docs/architecture/verify-figure0-slide.py

figure-0-platform.pptx is the inventory; figure-0-flow.pptx is the simplified
opener. They share a palette and a set of icons, so they share a linter.

1. Each is one native slide, 13.333 x 8.333 in, and nothing on it is a flattened
   diagram image — every picture is an icon or a logo, under 1.6 in wide.
2. Green means NVIDIA. The only greens in the chrome are 76B900 and C8E600;
   SUSE Jungle 30BA78 appears nowhere. Pictures are exempt by construction —
   the logos keep their own colours, which is the agreed exception.
3. Icons are used once each and are big enough to read. Both were review
   findings on the first draft of figure 0: eight icons were reused two or three
   times, and every one of them was drawn at about 22px.
4. Every component named in the agent plane is a real key in config_secops.yml.
   `_type` is a plugin-registry lookup, so an invented name would not start; a
   figure that names one is worse than an opaque box.
5. The flow slide stays simple (a text-run budget) and still says the four
   things that carry its argument.
"""
import hashlib
import importlib.util
import re
import sys
from pathlib import Path

from pptx import Presentation
from pptx.util import Inches

sys.dont_write_bytecode = True  # importing the builders must not litter __pycache__

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
ICONS = HERE / "icons"
CONFIG = REPO / "examples/secops-agent-factory/configs/config_secops.yml"

# (builder, deck, config cross-check?, min icon in, icons >= 0.34 in, text runs)
# The three numbers are the numeric definition of "the icons were reviewed" and
# "it was simplified". They are set just above what the slides do today, so a
# regression trips them and ordinary editing does not.
TARGETS = [
    ("make-figure0-slide.py", "figure-0-platform.pptx", True, 0.22, 0, None),
    ("make-figure0-flow-slide.py", "figure-0-flow.pptx", False, 0.20, 20, 115),
]

ALLOWED_GREEN = {"76B900", "C8E600"}

# The flow slide names these five and nothing else from the config. Each must
# appear on the slide (it is load-bearing) and in the config (it is real).
FLOW_NAMES = ["intent_classifier", "clarifier_agent", "deep_research_agent",
              "aiq_api", "knowledge_retrieval", "foundational_rag"]

# Simplification is allowed to drop components. It is not allowed to drop these.
MUST_SAY = {
    "figure-0-flow.pptx": [
        "holds for a human",       # the clarifier stops; it does not guess
        "cannot merge",            # the agent opens a PR and can do nothing else to it
        "FAIL-CLOSED",             # egress denies unless named
        "never enters the sandbox",  # credentials are injected at the boundary
    ],
}

failures = []


def check(ok, msg):
    print(("  ok    " if ok else "  FAIL  ") + msg)
    if not ok:
        failures.append(msg)


def is_green(hexstr):
    r, g, b = (int(hexstr[i:i + 2], 16) for i in (0, 2, 4))
    return g > 60 and g > r + 24 and g > b + 24


def colours_of(shape):
    """Every explicit sRGB value this shape contributes to the rendered slide."""
    return [m.group(1).upper()
            for m in re.finditer(r'srgbClr val="([0-9A-Fa-f]{6})"', shape._element.xml)]


def load(builder):
    spec = importlib.util.spec_from_file_location(Path(builder).stem, HERE / builder)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def palette_of(mod):
    """Reflect the declared colours. The flow builder imports most of its
    palette from the platform builder and reaches through `base` for the rest,
    so both namespaces count."""
    out = set()
    for ns in (mod, getattr(mod, "base", None)):
        if ns is None:
            continue
        out.update(str(v) for k, v in vars(ns).items()
                   if k.isupper() and type(v).__name__ == "RGBColor")
    return out


def icon_slugs():
    """blob hash -> slug, so a picture on a slide can be named. This is also how
    the uniqueness check knows which pictures are logos: logos may be small and
    are not part of the icon vocabulary."""
    return {hashlib.sha256(p.read_bytes()).hexdigest(): p.stem
            for p in sorted(ICONS.glob("*.png"))}


def verify(builder, deck, cross_check, min_icon, min_big, max_runs, slugs):
    print(f"\n=== {deck} ===")
    mod = load(builder)
    prs = Presentation(str(HERE / deck))

    print("structure")
    check(len(prs.slides) == 1, f"exactly one slide (got {len(prs.slides)})")
    check(prs.slide_width == Inches(13.333), "slide width is 13.333 in")
    check(prs.slide_height == Inches(8.333), "slide height is 8.333 in")

    slide = prs.slides[0]
    pics = [s for s in slide.shapes if s.shape_type == 13]
    oversize = [p for p in pics if p.width > Inches(1.6)]
    check(not oversize,
          f"{len(pics)} pictures, none wider than 1.6 in — no flattened diagram "
          f"(worst: {max((p.width / 914400 for p in pics), default=0):.2f} in)")

    print("\ncolour — green means NVIDIA")
    palette = palette_of(mod)
    used = set()
    for shape in slide.shapes:
        if shape.shape_type == 13:      # picture: the logos' own colours, exempt
            continue
        used.update(colours_of(shape))
    stray = sorted(used - palette)
    check(not stray, f"every chrome colour is a declared constant (stray: {stray})")
    check("30BA78" not in used, "SUSE Jungle 30BA78 appears nowhere in the chrome")
    bad = sorted(c for c in used if is_green(c) and c not in ALLOWED_GREEN)
    check(not bad, f"the only greens are {sorted(ALLOWED_GREEN)} (found also: {bad})")

    print("\nicons — one job each, big enough to read")
    seen = {}
    unknown = []
    for p in pics:
        slug = slugs.get(hashlib.sha256(p.image.blob).hexdigest())
        if slug is None:
            unknown.append(p.name)
            continue
        seen.setdefault(slug, []).append(p.height / 914400)
    check(not unknown, f"every picture comes from icons/ (unrecognised: {unknown})")
    dupes = sorted(s for s, h in seen.items() if len(h) > 1 and not s.startswith("logo-"))
    check(not dupes, f"no icon is used twice (reused: {dupes})")
    art = {s: h for s, h in seen.items() if not s.startswith("logo-")}
    small = sorted(s for s, h in art.items() if min(h) < min_icon - 1e-6)
    check(not small, f"every icon is at least {min_icon} in tall (too small: {small})")
    big = sum(1 for h in art.values() for v in h if v >= 0.34)
    check(big >= min_big,
          f"{big} icons are drawn at 0.34 in or more (need {min_big})")
    print(f"        {len(art)} distinct icons + {len(seen) - len(art)} logos")

    runs = [r.text for s in slide.shapes if s.shape_type != 13 and s.has_text_frame
            for par in s.text_frame.paragraphs for r in par.runs]
    text = "\n".join(runs)

    if max_runs is not None:
        print("\nsimplicity — it must stay an opener, not become an inventory")
        check(len(runs) <= max_runs, f"{len(runs)} text runs, budget {max_runs}")
        for claim in MUST_SAY.get(deck, []):
            check(claim in text, f'it still says "{claim}"')

    print("\ncomponents — every name greps out of the config")
    config = CONFIG.read_text()
    if cross_check:
        declared = {t for t in re.findall(r"^\s*_type:\s*(\S+)", config, re.M)}
        named = [n for _, n, _, _ in mod.AGENT_PLANE]
        for n in named:
            key = n.split(" ")[0]
            check(key in config, f"{key} is in {CONFIG.name}")
        # nim and console are on the slide too, but in the model plane and as
        # "telemetry · console" respectively, so they do not match by bare name.
        missing = sorted(declared - {n.split(" ")[0] for n in named} - {"nim", "console"})
        check(not missing, f"no config _type is left off the slide (missing: {missing})")
    else:
        for name in FLOW_NAMES:
            check(name in text and name in config,
                  f"{name} is on the slide and in {CONFIG.name}")


def main():
    slugs = icon_slugs()
    for builder, deck, cross, min_icon, min_big, max_runs in TARGETS:
        verify(builder, deck, cross, min_icon, min_big, max_runs, slugs)

    print()
    if failures:
        sys.exit(f"{len(failures)} check(s) failed")
    print("all checks passed")


if __name__ == "__main__":
    main()
