# CHARM data files

Every file here is a **CHARM CSV**: the NASA import template plus extra columns. Load any of them in the app with **Import data**. Build them again from the team's `charm_db` tables with:

```bash
python3 tools/build_crew_csv.py "<path to charm_db>" data
```

## The 9 crew files (`crew/`): real source values, never invented

| File | Crew member | Source person | What is real | Rows |
|---|---|---|---|---|
| `sarah_nasa-bedrest_C3C_7352.csv` | Sarah (F) | NASA bed rest C3C_7352: most complete volunteer (6 experiments) | Daily HR, BP, breathing, core temp, weight, fluid intake; Hb/Hct; glucose | 250 |
| `maya_nasa-bedrest_C3C_7772.csv` | Maya (F) | NASA bed rest C3C_7772 (2nd most complete) | same | 250 |
| `david_nasa-bedrest_C3E_6043.csv` | David (M) | NASA bed rest C3E_6043 (3rd most complete) | same, without fluid intake | 130 |
| `elena_nasa-bedrest_C3D_8615.csv` | Elena (F) | NASA bed rest C3D_8615 | same. **Resting HR 98**: shows the personal-offset feature | 125 |
| `marcus_inspiration4_C001.csv` | Marcus | Inspiration4 crew C001 (OSDR LSDS-7) | Blood count, 7 draws L-92 … R+194, **real spaceflight crew**, blood drawn on Earth | 7 |
| `mei_inspiration4_C002.csv` | Mei | Inspiration4 crew C002 | same | 7 |
| `robert_inspiration4_C003.csv` | Robert | Inspiration4 crew C003 | same | 7 |
| `amara_inspiration4_C004.csv` | Amara | Inspiration4 crew C004 | same | 7 |
| `john_csa-biomonitor_simulated.csv` | John (CSA) | CSA Bio-Monitor stream | **Simulated, not measured**: HR, SpO₂, breathing, BP every 5 min for 30 days, plus activity and radiation dose | 8 640 |

**Other notes:**
- **No CSA astronaut's individual data is public.** CSA publishes what Bio-Monitor measures, not the values. The CSA stream above is the closest CSA source and is labelled simulated everywhere.
- **Inspiration4 sex** is not in the source, so assigning the 4 people to crew members is arbitrary.
- **Bed-rest** is a ground analog of weightlessness (fluid shift, inactivity). It is not radiation or isolation.

## The 2 demo files (`demo/`): constructed, labelled `DEMO (constructed)` in the source column

| File | Story | Built from |
|---|---|---|
| `demo_sarah_red-alert.csv` | 35 h. Treadmill, then a **fast irregular heart rhythm at rest: CRITICAL** with SpO₂ and breathing CAUTION. The crew stops her, records an ECG, opens Emergency Mode, puts oxygen on and contacts the flight surgeon. Rhythm regular again → **back to NORMAL** | Sarah's real baseline (C3C_7352) + the CSA stream's 5-minute day pattern (sleep, work, exercise) |
| `demo_marcus_caution.csv` | 27 h. **Short sleep 5.4 h: CAUTION**, then low fluids: **heart rate > 100 and BP 88/58: CAUTION**. He drinks 1 L of rehydration fluid and rests, gets a second litre, and Charmy schedules a full sleep period → **all back to NORMAL** | NASA bed-rest crew-average baseline + CSA stream pattern. The plasma-volume loss in weightlessness is from the NASA bed-rest data. |

The `note` column holds what the crew did. Each note appears in **Alerts and history** at its own time, between the alert and the recovery.

## Reference tables (`reference/`)

| File | Use |
|---|---|
| `charm_reference_ranges.csv` | The team's reference ranges with sources (NEWS2, AHA/ACC, ADA, WHO, GLIM, AASM, NASA-STD-3001). Blood-panel levels in the app use them. |
| `crew_average_baselines.csv` | Crew averages from 29 bed-rest volunteers before bed rest (HR 69, BP 116/70, breathing 16.9, temp 36.5), plus the offset cap and the gap to critical. |
| `crew_personal_baselines.csv` | Each crew member's pre-mission average from `personal_baselines.csv`. |

## Personal alert limits
- **Caution limits** move by (person's baseline − crew average).
- **Critical limits never move.**
- The offset is capped at about 1.5× the spread between people (HR ±15, systolic ±11, diastolic ±10, breathing ±1.4, temperature ±0.4).
- A caution limit always stays inside its critical limit.
- At least 5 baseline readings are needed.
- The baseline is set automatically from the rows whose `phase` is `baseline` when a file is imported.
- The Crew Medical Officer can still override any limit. See Settings › Alert thresholds.

## How to load them (recommended order)
1. **Settings › Mission:** set the launch date to 59 days before today, so **today is Mission Day 60**. The bed-rest and Inspiration4 files place each row on its mission day; later days are not imported yet.
2. **Import the 9 crew files** with the default date choice:
   - Files with mission days are placed **by mission day**.
   - The CSA file uses **last row = now**.
3. **Import the demo files** (default: last row = now). After an import, CHARM replays its alert rules over the imported time, so the red and yellow periods, the crew notes and the return to normal all show in Alerts and history and on the timeline.

## CHARM CSV columns
`time_gmt, astronaut, agency, role, phase (baseline | mission | recovery), mission_day, heart_rate, spo2, resp_rate, temp_c, bp_systolic, bp_diastolic, glucose_mgdl, sleep_hours, radiation_dose_pct, weight_kg, fluid_intake_l, hemoglobin_g_dl, hematocrit_pct, wbc_k_per_ul, platelets_k_per_ul, lymphocytes_per_ul, irregular_rhythm (1), context (rest | ex | sleep), skin_temp_c, sim_label, source, note`

`weight_kg`, `fluid_intake_l`, `skin_temp_c` and `sim_label` are kept in the files but not shown in the app yet. Skin temperature is not core temperature, so it is never used for fever alerts.

**Not included:**
- The raw team files: `observations.csv` (55 MB) and `CHARM_Unified.xlsx`. Keep them in Drive or Git LFS.
- Bone scans and immune-cell panels, because the app has no screen for them yet.
- The solar file, which measures sunlight on the ground, not radiation at the spacecraft.
