import zipfile, sys, re

path = "/tmp/test-7b2.pptx"
results = []

def check(label, ok, detail=""):
    sym = "PASS" if ok else "FAIL"
    results.append((sym, label, detail))
    return ok

try:
    with zipfile.ZipFile(path, "r") as z:
        names = z.namelist()
        all_xml = ""
        for name in names:
            if re.match(r"ppt/slides/slide\d+\.xml$", name):
                all_xml += z.read(name).decode("utf-8", errors="replace")

        check("Valid ZIP/PPTX container", True)

        required = [
            "[Content_Types].xml",
            "ppt/presentation.xml",
            "ppt/slides/slide1.xml",
            "ppt/slides/slide2.xml",
            "ppt/slides/slide3.xml",
            "ppt/slides/slide4.xml",
            "ppt/slides/slide5.xml",
            "ppt/slides/slide6.xml",
            "ppt/slides/slide7.xml",
            "ppt/slides/slide8.xml",
            "ppt/slides/slide9.xml",
            "ppt/slides/slide10.xml",
        ]
        for r in required:
            check(f"Contains {r}", r in names)

        slides = [n for n in names if re.match(r"ppt/slides/slide\d+\.xml$", n)]
        n = len(slides)
        check(f"Slide count {n} >= 10 (all 10 sections)", n >= 10, f"{n} slides")
        check(f"Slide count {n} <= 20 (cap respected)", n <= 20)

        banned = [
            "fileRef", "imageRef", "datasetRef", "handoffCta", "editedFrom",
            "hadAttachment", "base64", "sessiontoken", "handofftoken",
            "builderid", "containerid", "neonproject", "flymachine",
        ]
        lo = all_xml.lower()
        for b in banned:
            check(f'No banned field "{b}"', b.lower() not in lo)

        check("Executive Summary text present", "executive" in lo)
        check("Root Cause text present", "root cause" in lo)
        check("KPI / Metric text present", "metric" in lo or "kpi" in lo)
        check("Action Plan text present", "action" in lo)
        check("Ora AI branding present", "ora ai" in lo)
        check("MustaFlow branding present", "mustaflow" in lo)
        check("Dark title background hex (0F172A) present", "0f172a" in all_xml.lower())
        check("Accent colour hex (2563EB) present", "2563eb" in all_xml.lower())

        uuid_in_text = bool(re.search(
            r">[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}<",
            all_xml,
        ))
        check("No raw UUID-style internal IDs in slide text", not uuid_in_text)

except zipfile.BadZipFile as e:
    check("Valid ZIP/PPTX container", False, str(e))

print("\n=== Phase 7B-2 PPTX Validation ===\n")
for sym, label, detail in results:
    suffix = f" -- {detail}" if detail else ""
    print(f"  [{sym}] {label}{suffix}")

fails = sum(1 for s, _, _ in results if s == "FAIL")
total = len(results)
print(f"\n{'ALL CHECKS PASSED' if fails == 0 else str(fails) + ' CHECK(S) FAILED'} ({total} total)")
sys.exit(0 if fails == 0 else 1)
