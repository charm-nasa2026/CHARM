#!/usr/bin/env python3
"""Copy the CHARM model's personal bands into shared/engine.js.

The team's alert model (charm_model/, model version charm-baseline-2.x) fits a personal baseline for every research
subject and adds the expected Earth -> Space shift for each mission day. This script asks the model, for each app crew
member and each mission day on a grid, for its Caution band at rest (expected +- 2.5 spreads) and writes the result
into the MODEL block of shared/engine.js. The app uses the band only to ADD an ATTENTION ("unusual for you"):
it never loosens a CHARM common limit and never moves a CRITICAL limit.

Usage:  python3 tools/build_model_profiles.py <folder that contains charm_model/> [shared/engine.js]
Needs numpy and pandas (the model's own requirements) and charm_model/out/charm_model_params.json (run fit_all.py first).
"""
import json, re, sys
sys.dont_write_bytecode = True
from pathlib import Path

# App crew id -> research subject in the model data (same people as data/crew/*.csv)
CREW = {
    "sarah": "C3_C3C_7352", "maya": "C3_C3C_7772", "david": "C3_C3E_6043", "elena": "C3_C3D_8615",
    "marcus": "I4_C001", "mei": "I4_C002", "robert": "I4_C003", "amara": "I4_C004",
    "john": "SIM_CSA-Astro-01",
}
METRICS = {"hr": "heart_rate", "sbp": "systolic_bp", "dbp": "diastolic_bp", "rr": "resp_rate", "temp": "body_temp"}
DAYS = [0, 1, 2, 4, 7, 14, 21, 30, 45, 60, 90, 120, 150, 180, 240, 365]   # mission days; 0 = on Earth before launch


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    base = Path(sys.argv[1]).resolve()
    pkg = base / "charm_model" if (base / "charm_model").is_dir() else base
    sys.path.insert(0, str(pkg))
    import config, engine  # the model's own modules
    model = engine.Model.load(str(pkg / "out" / "charm_model_params.json"))
    out = {"version": model.version if not callable(model.version) else model.version(), "z": config.Z_CAUTION, "crew": {}}
    for app_id, sid in CREW.items():
        bands = {}
        for key, metric in METRICS.items():
            b = model.baseline(sid, metric)
            if not b or b.get("mu") is None or (b.get("n") or 0) < config.MIN_BASELINE_N:
                continue        # no personal baseline: the app keeps the CHARM common limits only
            rows = []
            for d in DAYS:
                a = engine.assess(model, sid, metric, b["mu"], "2026-12-13T12:00:00",
                                  "earth" if d == 0 else "space", None if d == 0 else float(d), "rest")
                lo, hi = a["caution_band"]
                rows.append([d, round(a["expected"], 1), round(lo, 1) if lo is not None else None,
                             round(hi, 1) if hi is not None else None])
            bands[key] = {"n": b.get("n"), "rows": rows}
        sex = str((model.profile(sid) or {}).get("sex") or "").lower()
        entry = {"src": sid, "b": bands}
        if sex in ("male", "female"):
            entry["sex"] = sex      # used for the WHO hemoglobin limit (women 12, men 13 g/dL)
        if bands or "sex" in entry:
            out["crew"][app_id] = entry
    js_path = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parent.parent / "shared" / "engine.js"
    js = js_path.read_text(encoding="utf-8")
    block = "/* BEGIN MODEL */ var MODEL = " + json.dumps(out, separators=(",", ":")) + "; /* END MODEL */"
    new, n = re.subn(r"/\* BEGIN MODEL \*/.*?/\* END MODEL \*/", lambda m: block, js, flags=re.S)
    if n != 1:
        sys.exit("MODEL block not found in " + str(js_path))
    js_path.write_text(new, encoding="utf-8")
    print("Model bands written for: " + ", ".join(sorted(out["crew"])) + " (" + str(out["version"]) + ")")


if __name__ == "__main__":
    main()
