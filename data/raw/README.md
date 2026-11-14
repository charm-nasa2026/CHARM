# Raw team data (Git LFS)

These are the team's source files, unchanged. They are stored with **Git LFS** because they are large (about 130 MB in total). The app does not read them. `tools/build_crew_csv.py` turns them into the small CSV files in `data/crew`, `data/demo` and `data/reference`, which are normal git files.

## Get the files after cloning
```bash
git lfs install      # once per computer
git lfs pull         # downloads the real files; without it you only get small pointer files
```

## What is here

| Folder | File | What it is |
|---|---|---|
| `charm_db/` | `observations.csv` | One row per measurement, every value traceable to its source file, row and column |
| | `daily_panel.csv` | One row per person per day, one column per measurement, % change from pre-bed-rest |
| | `context_timeseries.csv` | ISS RR-1 2014 cabin air (5 min) and radiation (daily) |
| | `derived_features.csv` | % change from each person's pre-phase values |
| | `personal_baselines.csv` | Per person and measurement: n, mean, sd before bed rest / before flight |
| | `reference_ranges.csv` | Reference ranges with sources and unit factors |
| | `participants.csv`, `parameters.csv`, `population_stats.csv`, `README.txt` | Indexes and the eye-health group statistics |
| | `CHARM_Unified.xlsx` | The same data for people: one sheet per person |
| `final_data/` | `Health_Observations_By_Participant_and_Parameter.xlsx` | Earlier combined workbook (same observations) |
| | `charm_reference_ranges.csv` / `.xlsx` | Reference ranges as written by the team |

## Sources
- **NASA bed-rest campaigns** (UTMB C1, C3, C11). These are the BRSM / MR datasets from the NASA Life Sciences Data Archive / OSDR.
- **Inspiration4 complete blood count:** OSDR LSDS-7.
- **ISS environment:** OSDR EDA RR-1, 2014.
- **CSA Bio-Monitor stream:** simulated, not measured.

No person in these files was measured in space. See `data/README.md` for how each crew member maps to a source person.

## Rebuild the app CSV files
```bash
python3 tools/build_crew_csv.py data/raw/charm_db data
```
