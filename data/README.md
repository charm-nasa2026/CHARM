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
| `marcus_inspiration4_C001.csv` | Marcus | Inspiration4 crew C001 (OSDR LSDS-7) | Blood count, 7 draws L-92 … R+194, **real spaceflight crew**, blood drawn on Earth; space radiation (NOAA proton flux) on each date and on the 3 flight days | 11 |
| `mei_inspiration4_C002.csv` | Mei | Inspiration4 crew C002 | same | 11 |
| `robert_inspiration4_C003.csv` | Robert | Inspiration4 crew C003 | same | 11 |
| `amara_inspiration4_C004.csv` | Amara | Inspiration4 crew C004 | same | 11 |
| `john_csa-biomonitor_simulated.csv` | John (CSA) | CSA Bio-Monitor stream | **Simulated, not measured**: HR, SpO₂, breathing, BP every 5 min for 30 days, plus activity and radiation dose | 8 640 |

**Space radiation for the Inspiration4 crew (`proton_flux_pfu`):**
- Real NOAA SWPC values: the GOES daily proton fluence above 10 MeV for each date, from the Solar and Geophysical Activity Summary archived by NOAA NCEI ([archive](https://www.ngdc.noaa.gov/stp/space-weather/swpc-products/daily_reports/solar_geophysical_activity_summaries/)). Daily average flux (pfu) = fluence ÷ 86 400.
- Rows: the 7 blood-draw dates, the 3 days in orbit (16–18 Sep 2021, mission days 1–3, no blood draw), and the peak of the proton event on 31 Mar 2022 (10.6 pfu at 06:30 UTC, an S1 radiation storm, about 1.5 h before the R+194 draw).
- 3 Aug 2021: that day's report is not in the archive; the days before and after were both 4.4e4, so 0.51 pfu is used.
- This is the radiation **environment in space** (measured by GOES satellites), the same measure as the app's live Space weather card. It is not the crew's personal dose: no Inspiration4 dosimeter data is public, so `radiation_dose_pct` stays empty. On the draw dates the crew was on Earth.
- On import, these values go to the shared **Space weather** timeline (all crew), placed at each row's mission day. The same point from 4 files is stored once.

**Other notes:**
- **No CSA astronaut's individual data is public.** CSA publishes what Bio-Monitor measures, not the values. The CSA stream above is the closest CSA source and is labelled simulated everywhere.
- **Inspiration4 sex** is not in the source, so assigning the 4 people to crew members is arbitrary.
- **Bed-rest** is a ground analog of weightlessness (fluid shift, inactivity). It is not radiation or isolation.

## The 2 demo files (`demo/`): constructed, labelled `DEMO (constructed)` in the source column

| File | Story | Built from |
|---|---|---|
| `demo_sarah_red-alert.csv` | 35 h. Treadmill, then a **fast irregular heart rhythm at rest: CRITICAL** with SpO₂ and breathing CAUTION. The crew stops her, records an ECG, opens Emergency Mode, puts oxygen on and contacts the flight surgeon. Rhythm regular again → **back to NORMAL** | Sarah's real baseline (C3C_7352) + the CSA stream's 5-minute day pattern (sleep, work, exercise) |
| `demo_marcus_caution.csv` | 27 h. **Short sleep 5.4 h: ATTENTION**, then low fluids: **heart rate > 100 and BP 88/58: CAUTION**. He drinks 1 L of rehydration fluid and rests, gets a second litre, and Charmy schedules a full sleep period → **all back to NORMAL** | NASA bed-rest crew-average baseline + CSA stream pattern. The plasma-volume loss in weightlessness is from the NASA bed-rest data. |

The `note` column holds what the crew did. Each note appears in **Alerts and history** at its own time, between the alert and the recovery.

## Medic-team scenarios (`scenarios/`)
One CSV per scenario, with the team's PDFs and implementation notes in `scenarios/pdf/`. `python3 tools/build_scenarios.py` builds them into `public/js/scenarios.js`, so **Simulate scenario** works offline. Order in the app:
1. `bleeding_emergency_scenario.csv`: bleeding emergency, 8 stages (first-aid steps from Stop the Bleed, American College of Surgeons).
2. `arrhythmia_scenario.csv`: cardiac arrhythmia, 8 stages (screening flag → ECG required → reviewed AF → unstable, AHA tachyarrhythmia algorithm).
3. `airborne_allergy_emergency_scenario.csv`: airborne exposure / respiratory emergency, 8 stages. Stage 1 HR, BP, RR and temperature are the rounded pre-bed-rest means of NASA CFT70 subject C11_CFT70_8072; SpO₂ and later values are synthetic.
4. `pulmonary_infection_scenario.csv` (8), `dehydration_scenario.csv` (10), `sans_scenario.csv` (11), `bone_health_chronic_scenario.csv` (7).

All scenario values are constructed for the demo and stored with `src: 'scenario'` (DEMO) when run live.

## Reference tables (`reference/`)

| File | Use |
|---|---|
| `charm_alert_rules.csv` | **The medic team's exact alert thresholds** (CHARM_Exact_Alert_Thresholds.pdf), 26 rules over 6 conditions: VTE, atrial fibrillation, orthostatic hypotension, infection (SIRS / qSOFA), kidney stones, SANS. Each row has the level (ATTENTION / CAUTION / CRITICAL), app message, next step, source and how CHARM implements it. |
| `charm_reference_ranges.csv` | The team's reference ranges with sources (NEWS2, AHA/ACC, ADA, WHO, GLIM, AASM, NASA-STD-3001). Blood-panel levels in the app use them. |
| `crew_average_baselines.csv` | Crew averages from 29 bed-rest volunteers before bed rest (HR 69, BP 116/70, breathing 16.9, temp 36.5), plus the offset cap and the gap to critical. |
| `crew_personal_baselines.csv` | Each crew member's pre-mission average from `personal_baselines.csv`. |

## Personal alert limits
- For the 9 crew members the **CHARM model** sets the personal band (see the main README, "Personal limits: the CHARM model"). The crew-average offset below is used only for a crew member the model does not know.
- **Offsets only tighten** a limit (team decision 15.11): a high-normal person still gets ATTENTION at the common limit. The flight surgeon can loosen a limit by hand.
- **Attention (yellow) limits** and the orange infection-screen numbers move by (person's baseline − crew average).
- **Critical limits never move.**
- The offset is capped at about 1.5× the spread between people (HR ±15, systolic ±11, diastolic ±10, breathing ±1.4, temperature ±0.4).
- A caution limit always stays inside its critical limit.
- At least 5 baseline readings are needed.
- The baseline is set automatically from the rows whose `phase` is `baseline` when a file is imported.
- The Crew Medical Officer can still override any limit. See Settings › Alert thresholds.

## How to load them (recommended order)
**One click:** Settings › Demo › **Crew data library** › **Load all crew data**. The files are served with the app (`tools/sync-shared.js` copies `data/` to `public/data/` on every deploy), and CHARM imports, for every astronaut in the crew, the real file and then the simulated filler. The manual way:

1. **Settings › Mission:** set the launch date to 59 days before today, so **today is Mission Day 60**. The bed-rest and Inspiration4 files place each row on its mission day; later days are not imported yet.
2. **Import the 9 crew files** with the default date choice:
   - Files with mission days are placed **by mission day**.
   - The CSA file uses **last row = now**.
3. **Import the demo files** (default: last row = now). After an import, CHARM replays its alert rules over the imported time, so the red and yellow periods, the crew notes and the return to normal all show in Alerts and history and on the timeline.

## Alert levels
| Level | Colour | Meaning |
|---|---|---|
| NORMAL | green | no listed trigger met |
| ATTENTION | yellow | one screening limit crossed |
| CAUTION | orange | a medical criterion or a multi-signal pattern (condition alert) |
| CRITICAL | red | urgent; limits never move with personal offsets |

Personal limits can only tighten the yellow limits and the orange infection-screen numbers; red stays fixed.

## Simulated filler data (`crew-simulated/`)
Values for the measurements each person's real file does **not** have, so every tile has a value. They never replace or overlap a real value.

| File | Fills |
|---|---|
| `sarah_simulated.csv`, `maya_simulated.csv`, `david_simulated.csv` | SpO₂, sleep, glucose (daily), mood, exercise, radiation dose, fluid intake (David), WBC / platelets / lymphocytes, weekly ECG review, orthostatic test, urine check, 2-weekly neck-vein and eye exams, daily symptom check |
| `marcus_simulated.csv`, `robert_simulated.csv`, `amara_simulated.csv` | All vital signs (their real files are Inspiration4 blood counts only), plus the same set as above (blood counts stay real) |
| `john_simulated.csv` | Core temperature, glucose, sleep, mood, exercise, fluids, blood panel, exams (his base stream is CSA's simulated Bio-Monitor) |

**Real-only (no filler on purpose): Elena and Mei.** Their tiles show NO DATA where there is no real measurement.

**Orange days:** each filler file has one CAUTION day in the last two weeks (`CAUTION_DAYS` in `tools/build_crew_csv.py`): SpO₂ 93 % (Sarah day 52, Maya day 55, Robert day 58), glucose below 70 (Marcus day 49, John day 57), an orthostatic drop of 24 mmHg (David day 56), blood in urine (Amara day 49). Reload the crew data library to see them.

**How the filler is built:**
- **Anchors:** values are anchored to the person's real pre-mission baseline when one exists. Otherwise they use the NASA bed-rest crew average.
- **Trend:** a slow drift over the mission (fluid shift, deconditioning).
- **Mostly NORMAL:** results are mostly NORMAL, with a few realistic ATTENTION days, such as a short night or a low-fluid day.
- **Reproducible:** the random numbers are seeded, so every build gives the same files.

**How it's marked:**
- Every row has `data_type = simulated`. In the app each value shows a **SIM** tag (real values show **REAL**), simulated chart lines are dashed, and confidence is shown as Low.
- Simulated rows never set a personal baseline.
- The demo files and John's CSA stream are also `simulated`.

**Load order:** import the real crew file first, then that person's simulated file. Both use mission days.

## CHARM CSV columns
`time_gmt, astronaut, agency, role, phase (baseline | mission | recovery), mission_day, heart_rate, spo2, resp_rate, temp_c, bp_systolic, bp_diastolic, glucose_mgdl, sleep_hours, radiation_dose_pct, proton_flux_pfu, weight_kg, fluid_intake_l, hemoglobin_g_dl, hematocrit_pct, wbc_k_per_ul, platelets_k_per_ul, lymphocytes_per_ul, irregular_rhythm (1), context (rest | ex | sleep), skin_temp_c, sim_label, ecg_irregular, ecg_no_p_waves, ecg_seconds, ecg_unstable, ortho_lying_sbp, ortho_lying_dbp, ortho_standing_sbp, ortho_standing_dbp, ortho_minutes, syncope, source, note`

The importer also reads `urine_24h_l, urine_blood, kidney_ultrasound (none|stone|hydro), ijv_velocity_cm_s, ijv_retrograde, ijv_thrombus, sans_delta_trt_um, sans_frisen_grade, sans_refraction_shift_d, sans_folds (none|any|sharp), sans_globe_flattening (none|present|moderate), symptom_suspected_infection, symptom_confusion, symptom_fainting, symptom_chest_pain`. Yes/no columns take 1/0.

`weight_kg` is imported as **Body mass** (trend alerts over 14 and 30 days). `fluid_intake_l` is the Fluid intake tile. `skin_temp_c` and `sim_label` are kept in the files but not shown in the app yet. Skin temperature is not core temperature, so it is never used for fever alerts.

**Not included:**
- The raw team files: `observations.csv` (55 MB) and `CHARM_Unified.xlsx`. Keep them in Drive or Git LFS.
- Bone scans and immune-cell panels, because the app has no screen for them yet.
- The solar file, which measures sunlight on the ground, not radiation at the spacecraft.
