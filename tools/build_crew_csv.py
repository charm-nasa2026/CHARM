#!/usr/bin/env python3
"""
Build the CHARM crew CSV files from the team's charm_db tables.

    python3 tools/build_crew_csv.py <path to charm_db folder> [output folder, default data/]

Inputs (from charm_db): observations.csv, personal_baselines.csv, reference_ranges.csv.
Outputs (CHARM CSV format, importable in the app with Import data):
  data/crew/*.csv        one file per crew member, real source values, unchanged except unit conversion
  data/demo/*.csv        two constructed demo scenarios (clearly labelled), built on the real baselines and the CSA stream pattern
  data/reference/*.csv   reference ranges and the crew-average baselines used for personal offsets

Values are never invented in data/crew. Units: fluid g/day -> L/day, cumulative effective dose mSv -> % of the 600 mSv NASA career limit.
"""
import csv, os, sys, math, statistics, collections, datetime as dt

SRC = sys.argv[1] if len(sys.argv) > 1 else 'charm_db'
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), '..', 'data')

COLS = ['time_gmt', 'astronaut', 'agency', 'role', 'phase', 'mission_day',
        'heart_rate', 'spo2', 'resp_rate', 'temp_c', 'bp_systolic', 'bp_diastolic', 'glucose_mgdl', 'sleep_hours',
        'radiation_dose_pct', 'mood_0_10', 'exercise_pct', 'weight_kg', 'fluid_intake_l',
        'hemoglobin_g_dl', 'hematocrit_pct', 'wbc_k_per_ul', 'platelets_k_per_ul', 'lymphocytes_per_ul',
        'irregular_rhythm', 'context', 'skin_temp_c', 'sim_label',
        'ecg_irregular', 'ecg_no_p_waves', 'ecg_seconds', 'ecg_unstable',
        'ortho_lying_sbp', 'ortho_lying_dbp', 'ortho_standing_sbp', 'ortho_standing_dbp', 'ortho_minutes', 'syncope',
        'urine_24h_l', 'urine_blood', 'kidney_ultrasound', 'ijv_velocity_cm_s', 'ijv_retrograde', 'ijv_thrombus',
        'sans_delta_trt_um', 'sans_frisen_grade', 'sans_refraction_shift_d', 'sans_folds', 'sans_globe_flattening',
        'symptom_suspected_infection', 'symptom_confusion', 'symptom_fainting', 'symptom_chest_pain',
        'data_type', 'source', 'note']

# crew member -> source person
CREW = {
    'sarah':  ('Sarah',  'NASA', 'Flight Engineer',      'C3_C3C_7352', 'NASA bed rest C3C_7352 (Earth analog)'),
    'maya':   ('Maya',   'NASA', 'Flight Engineer',      'C3_C3C_7772', 'NASA bed rest C3C_7772 (Earth analog)'),
    'david':  ('David',  'NASA', 'Pilot',                'C3_C3E_6043', 'NASA bed rest C3E_6043 (Earth analog)'),
    'elena':  ('Elena',  'ESA',  'Mission Specialist',   'C3_C3D_8615', 'NASA bed rest C3D_8615 (Earth analog)'),
    'marcus': ('Marcus', 'NASA', 'Commander',            'I4_C001', 'Inspiration4 crew C001 · OSDR LSDS-7'),
    'mei':    ('Mei',    'JAXA', 'Mission Specialist',   'I4_C002', 'Inspiration4 crew C002 · OSDR LSDS-7'),
    'robert': ('Robert', 'NASA', 'Mission Specialist',   'I4_C003', 'Inspiration4 crew C003 · OSDR LSDS-7'),
    'amara':  ('Amara',  'NASA', 'Payload Specialist',   'I4_C004', 'Inspiration4 crew C004 · OSDR LSDS-7'),
    'john':   ('John',   'CSA',  'Crew Medical Officer', 'SIM_CSA-Astro-01', 'CSA Bio-Monitor stream (simulated, not measured)'),
}
PARAM_COL = {'heart_rate': 'heart_rate', 'spo2': 'spo2', 'resp_rate': 'resp_rate', 'body_temp': 'temp_c', 'systolic_bp': 'bp_systolic',
             'diastolic_bp': 'bp_diastolic', 'blood_glucose': 'glucose_mgdl', 'sleep_duration': 'sleep_hours', 'weight': 'weight_kg',
             'fluid_intake': 'fluid_intake_l', 'hemoglobin': 'hemoglobin_g_dl', 'hematocrit': 'hematocrit_pct', 'wbc_count': 'wbc_k_per_ul',
             'platelet_count': 'platelets_k_per_ul', 'lymphocytes_abs': 'lymphocytes_per_ul', 'skin_temp': 'skin_temp_c',
             'radiation_cumulative_effective': 'radiation_dose_pct'}
PHASE = {'pre_bedrest': 'baseline', 'bedrest': 'mission', 'recovery': 'recovery', 'pre_flight': 'baseline', 'post_flight': 'recovery', 'in_flight_simulated': 'mission'}
# Inspiration4: launch 2021-09-16, splashdown 2021-09-18 (UTC). Blood draw time of day is not in the source: 08:00 is used.
I4_LAUNCH, I4_RETURN = dt.date(2021, 9, 16), dt.date(2021, 9, 18)
DEFAULT_TIME = {'blood_glucose': '06:30', 'hemoglobin': '07:30', 'hematocrit': '07:30', 'fluid_intake': '21:00', 'weight': '06:00'}


def fnum(x):
    try:
        v = float(x)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def fmt(v, d):
    return '' if v is None else (str(int(round(v))) if d == 0 else ('%.' + str(d) + 'f') % v)


def load():
    want = {c[3] for c in CREW.values()}
    rows = collections.defaultdict(list)
    with open(os.path.join(SRC, 'observations.csv'), encoding='utf-8-sig') as f:
        for x in csv.DictReader(f):
            if x['participant_id'] in want and x['parameter_id'] in PARAM_COL and x['mission_phase'] in PHASE:
                if fnum(x['value_numeric']) is None:
                    continue
                rows[x['participant_id']].append(x)
    return rows


def bedrest_file(key, obs):
    name, agency, role, pid, source = CREW[key]
    by = collections.OrderedDict()
    for x in obs:
        tm = x['time'] if x['time'] and x['time'][:1].isdigit() else DEFAULT_TIME.get(x['parameter_id'], '07:00')
        k = (x['date'], tm)
        r = by.setdefault(k, {'time_gmt': x['date'] + 'T' + tm + ':00Z', 'phase': PHASE[x['mission_phase']],
                              'mission_day': fmt(fnum(x['mission_day']), 0)})
        v = fnum(x['value_numeric'])
        if x['parameter_id'] == 'fluid_intake':
            v = v / 1000.0
        r[PARAM_COL[x['parameter_id']]] = v
    out = []
    for k in sorted(by):
        r = by[k]
        row = {c: '' for c in COLS}
        row.update(time_gmt=r['time_gmt'], astronaut=name, agency=agency, role=role, phase=r['phase'], mission_day=r['mission_day'], source=source)
        for c, d in [('heart_rate', 0), ('resp_rate', 0), ('temp_c', 1), ('bp_systolic', 0), ('bp_diastolic', 0), ('glucose_mgdl', 0),
                     ('weight_kg', 1), ('fluid_intake_l', 2), ('hemoglobin_g_dl', 1), ('hematocrit_pct', 1)]:
            if c in r:
                row[c] = fmt(r[c], d)
        out.append(row)
    return out


def i4_file(key, obs):
    name, agency, role, pid, source = CREW[key]
    by = collections.defaultdict(dict)
    for x in obs:
        lab = x['nasa_day_label']
        by[lab][PARAM_COL[x['parameter_id']]] = fnum(x['value_numeric'])
    out = []
    for lab, vals in by.items():
        n = int(lab[2:])
        if lab.startswith('L-'):
            d, md, ph = I4_LAUNCH - dt.timedelta(days=n), 1 - n, 'baseline'
        else:
            d, md, ph = I4_RETURN + dt.timedelta(days=n), 3 + n, 'recovery'
        row = {c: '' for c in COLS}
        row.update(time_gmt=d.isoformat() + 'T08:00:00Z', astronaut=name, agency=agency, role=role, phase=ph, mission_day=str(md),
                   source=source + ' · draw ' + lab + ' · blood drawn on Earth')
        for c, dd in [('hemoglobin_g_dl', 1), ('hematocrit_pct', 1), ('wbc_k_per_ul', 1), ('platelets_k_per_ul', 0), ('lymphocytes_per_ul', 0)]:
            if c in vals:
                row[c] = fmt(vals[c], dd)
        out.append(row)
    out.sort(key=lambda r: r['time_gmt'])
    return out


CTX = {'Sleep': 'sleep', 'Exercise': 'ex', 'Rest': 'rest', 'Working': 'rest'}


def sim_series(obs):
    by = collections.OrderedDict()
    for x in sorted(obs, key=lambda x: (x['date'], x['time'])):
        k = (x['date'], x['time'])
        r = by.setdefault(k, {'t': dt.datetime.fromisoformat(x['date'] + 'T' + x['time']), 'ctx': CTX.get(x['activity_state'], 'rest'), 'label': ''})
        r[PARAM_COL[x['parameter_id']]] = fnum(x['value_numeric'])
        q = x.get('quality_flag') or ''
        if 'generator:' in q:
            lab = q.split('generator:')[-1].strip()
            if lab and lab != 'None':
                r['label'] = lab
    return list(by.values())


def csa_file(key, obs):
    name, agency, role, pid, source = CREW[key]
    out = []
    for r in sim_series(obs):
        row = {c: '' for c in COLS}
        row.update(time_gmt=r['t'].strftime('%Y-%m-%dT%H:%M:00Z'), astronaut=name, agency=agency, role=role, phase='mission',
                   context=r['ctx'], sim_label=r['label'], source=source)
        for c, d in [('heart_rate', 0), ('spo2', 0), ('resp_rate', 0), ('bp_systolic', 0), ('bp_diastolic', 0), ('skin_temp_c', 1)]:
            if r.get(c) is not None:
                row[c] = fmt(r[c], d)
        if r.get('radiation_dose_pct') is not None:
            row['radiation_dose_pct'] = fmt(r['radiation_dose_pct'] / 600.0 * 100.0, 3)
        out.append(row)
    return out


# ---------------- demo scenarios (constructed, clearly labelled) ----------------
def clean_window(series, hours):
    """33-hour window starting 06:00 with the fewest simulator anomaly labels. Labelled rows are replaced by the previous
    normal row, so the demo's only events are the ones the scenario adds on purpose."""
    n = hours * 12
    starts = [s for s in range(0, len(series) - n) if series[s]['t'].hour == 6 and series[s]['t'].minute == 0]
    s = min(starts, key=lambda s: sum(1 for x in series[s:s + n] if x['label']))
    win, last = [], None
    for x in series[s:s + n]:
        if x['label'] and last:
            y = dict(last); y['t'] = x['t']; y['ctx'] = x['ctx']; y['label'] = ''
            win.append(y)
        else:
            win.append(x); last = x
    return win


def rest_median(win, k):
    return statistics.median([x[k] for x in win if x['ctx'] == 'rest' and x.get(k) is not None])


def demo_rows(win, who, base_hr, base_rr, start, events, extra, source):
    """events: list of (minute_from_start, minute_end, fn(row, minute) -> None) applied in order."""
    name, agency, role = who
    dhr, drr = base_hr - rest_median(win, 'heart_rate'), base_rr - rest_median(win, 'resp_rate')
    rows = []
    for i, x in enumerate(win):
        m = i * 5
        t = start + dt.timedelta(minutes=m)
        r = {'heart_rate': x['heart_rate'] + dhr, 'spo2': min(100, x['spo2']), 'resp_rate': x['resp_rate'] + drr, 'context': x['ctx']}
        if r['context'] == 'sleep':   # the template stream sleeps lower than this person's baseline allows
            r['heart_rate'] = max(r['heart_rate'], base_hr - 23)
        if r['context'] == 'ex':      # keep scheduled exercise inside the normal exercise range (only the scenario events alert)
            r['heart_rate'] = min(r['heart_rate'], 158); r['resp_rate'] = min(r['resp_rate'], 26)
        for a, b, fn in events:
            if a <= m < b:
                fn(r, m)
        row = {c: '' for c in COLS}
        row.update(time_gmt=t.strftime('%Y-%m-%dT%H:%M:00Z'), astronaut=name, agency=agency, role=role, phase='mission', source=source,
                   heart_rate=fmt(r['heart_rate'], 0), spo2=fmt(r['spo2'], 0), resp_rate=fmt(r['resp_rate'], 0), context=r['context'] or '',
                   irregular_rhythm='1' if r.get('irr') else '')
        for c, v in extra.get(m, {}).items():
            row[c] = v
        rows.append(row)
    return rows


def build_demos(sim, base):
    win = clean_window(sim, 36)
    start = dt.datetime(2026, 11, 13, 6, 0)

    # --- Demo 1: Sarah · CRITICAL (fast irregular heart rhythm after exercise) -> treated -> back to NORMAL
    hrb = base['C3_C3C_7352']['heart_rate']['mean']
    S0 = 24 * 60 + 7 * 60 + 50     # day 2, 13:50 relative to 06:00 start
    ev = [
        (S0, S0 + 30, lambda r, m: r.update(context='ex', heart_rate=118 + (m - S0) * 1.0)),                              # treadmill
        (S0 + 30, S0 + 60, lambda r, m: r.update(context='rest', heart_rate=138 + (m % 15), irr=True,
                                                 spo2=92 if m < S0 + 50 else 93, resp_rate=23)),                          # CRITICAL at rest
        (S0 + 60, S0 + 85, lambda r, m: r.update(context='rest', heart_rate=124 - (m - S0 - 60) * 1.6,
                                                 irr=m < S0 + 70, spo2=97, resp_rate=19)),                                # settling
        (S0 + 85, S0 + 200, lambda r, m: r.update(context='rest', heart_rate=hrb + 6 - min(6, (m - S0 - 85) / 15), spo2=98, resp_rate=16)),
    ]
    note = lambda txt: {'note': txt}
    ex = {
        60: {'sleep_hours': '7.1'}, 90: {'bp_systolic': '106', 'bp_diastolic': '64', 'temp_c': '36.7'},
        24 * 60 + 60: {'sleep_hours': '6.9'}, 24 * 60 + 90: {'bp_systolic': '104', 'bp_diastolic': '62', 'temp_c': '36.8'},
        S0: note('Treadmill session started (scheduled exercise).'),
        S0 + 35: dict(note('Charmy: fast irregular heart rhythm at rest after exercise. Red alert to all crew. Sarah stopped and lay down; crew strapped her in.'),
                      bp_systolic='98', bp_diastolic='62'),
        S0 + 40: dict(note('1-minute ECG reviewed: irregular RR intervals and no P waves (AF criterion). Emergency Mode opened; flight surgeon notified with priority.'),
                      ecg_irregular='1', ecg_no_p_waves='1', ecg_seconds='60', ecg_unstable='0'),
        S0 + 50: note('Oxygen mask on, oral fluids. Flight surgeon (on the Earth link) confirmed: rest, keep monitoring, follow the cardiac checklist.'),
        S0 + 75: dict(note('Repeat 1-minute ECG: regular rhythm again. Oxygen off.'), bp_systolic='104', bp_diastolic='64', temp_c='36.9',
                      ecg_irregular='0', ecg_no_p_waves='0', ecg_seconds='60', ecg_unstable='0'),
        S0 + 120: dict(note('Rhythm stable for 45 minutes. Exercise paused for 24 h; repeat ECG before the next session (flight surgeon).'),
                       bp_systolic='105', bp_diastolic='63'),
    }
    for m in range(0, 33 * 60, 30):
        ex.setdefault(m, {}).setdefault('temp_c', fmt(36.6 + 0.2 * math.sin(m / 1440 * 2 * math.pi), 1))
    src1 = 'DEMO (constructed) · baseline from NASA bed rest C3C_7352 · 5-min pattern from CSA Bio-Monitor stream'
    d1 = demo_rows(win, ('Sarah', 'NASA', 'Flight Engineer'), hrb, base['C3_C3C_7352']['resp_rate']['mean'], start, ev, ex, src1)
    d1 = [r for r in d1 if r['time_gmt'] <= (start + dt.timedelta(minutes=S0 + 200)).strftime('%Y-%m-%dT%H:%M:00Z')]

    # --- Demo 2: Marcus · ATTENTION (short sleep, low fluids) + CAUTION (orthostatic BP drop) -> fixed -> NORMAL
    hrc, rrc = 69.0, 16.9          # crew average from the NASA bed-rest pre-phase (Marcus has no own vital-sign baseline)
    D0 = 7 * 60                    # day 1 13:00
    ev2 = [
        (D0, D0 + 100, lambda r, m: r.update(context='rest', heart_rate=101 + min(7, (m - D0) / 10) + (m % 10) / 5, spo2=97, resp_rate=18)),
        (D0 + 100, D0 + 160, lambda r, m: r.update(context='rest', heart_rate=106 - (m - D0 - 100) * 0.4, spo2=98, resp_rate=17)),
        (D0 + 160, D0 + 300, lambda r, m: r.update(context='rest', heart_rate=min(r['heart_rate'], 82), resp_rate=min(r['resp_rate'], 17))),  # exercise skipped today
    ]
    ex2 = {
        60: dict(sleep_hours='5.4', note='Sleep 5.4 h (caution, below 6 h). Late EVA preparation the evening before.'),
        90: {'bp_systolic': '118', 'bp_diastolic': '74', 'temp_c': '36.7'},
        6 * 60: {'fluid_intake_l': '0.9', 'note': 'Fluid intake by midday: 0.9 L (plan: 2.5 L per day).'},
        D0 + 10: {'bp_systolic': '92', 'bp_diastolic': '60'},
        D0 + 30: dict(bp_systolic='88', bp_diastolic='58', note='Charmy: heart rate above 100 at rest and blood pressure low (caution). Likely low fluids: in weightlessness blood plasma volume already falls about 10%.'),
        D0 + 35: dict(note('Orthostatic test: lying 116/74; standing 3 min 92/60 (drop 24/14; criterion met).'), ortho_lying_sbp='116', ortho_lying_dbp='74',
                      ortho_standing_sbp='92', ortho_standing_dbp='60', ortho_minutes='3', syncope='0'),
        D0 + 40: note('Marcus drank 1 L of oral rehydration fluid and rested seated. Repeat blood pressure in 20 minutes (Charmy reminder).'),
        D0 + 60: {'bp_systolic': '96', 'bp_diastolic': '62'},
        D0 + 100: {'bp_systolic': '108', 'bp_diastolic': '68', 'note': 'Repeat blood pressure 108/68. Second litre of fluids during the afternoon.'},
        D0 + 120: dict(note('Repeat orthostatic test: lying 116/73; standing 3 min 111/71. Back to NORMAL.'), ortho_lying_sbp='116', ortho_lying_dbp='73',
                       ortho_standing_sbp='111', ortho_standing_dbp='71', ortho_minutes='3', syncope='0'),
        D0 + 150: {'bp_systolic': '114', 'bp_diastolic': '72', 'fluid_intake_l': '2.6'},
        15 * 60: dict(note='Charmy moved the evening tasks so Marcus gets a full 8-hour sleep period.'),
        24 * 60 + 60: dict(sleep_hours='7.8', note='Sleep 7.8 h. Sleep back to NORMAL.'),
        24 * 60 + 90: {'bp_systolic': '117', 'bp_diastolic': '73', 'temp_c': '36.6'},
    }
    for m in range(0, 28 * 60, 30):
        ex2.setdefault(m, {}).setdefault('temp_c', fmt(36.6 + 0.2 * math.sin(m / 1440 * 2 * math.pi), 1))
    src2 = 'DEMO (constructed) · NASA bed-rest crew-average baseline · 5-min pattern from CSA Bio-Monitor stream'
    d2 = demo_rows(win, ('Marcus', 'NASA', 'Commander'), hrc, rrc, start, ev2, ex2, src2)
    d2 = [r for r in d2 if r['time_gmt'] <= (start + dt.timedelta(hours=27, minutes=30)).strftime('%Y-%m-%dT%H:%M:00Z')]
    return d1, d2


# ---------------- simulated filler (data/crew-simulated) ----------------
SIM_FILL = ['sarah', 'maya', 'david', 'marcus', 'robert', 'amara', 'john']     # not elena, not mei: they stay real-only
REAL_ONLY = ['elena', 'mei']
MD_FROM, MD_TO = -15, 60          # mission days written (today = Day 60 when the launch is set 59 days back)


def sim_fill(key, real_rows, base):
    """Values only for measurements this person's real file does not have. Anchored to the person's real pre-mission
    baseline when it exists, otherwise to the NASA bed-rest crew average. Seeded, so every build is identical.
    Mostly NORMAL, with a few realistic ATTENTION days (a short night, a low-fluid day)."""
    import random
    name, agency, role, pid, src = CREW[key]
    rnd = random.Random('charm-sim-' + key)
    skip = {'time_gmt', 'astronaut', 'agency', 'role', 'phase', 'mission_day', 'source', 'note', 'data_type', 'context', 'sim_label', 'skin_temp_c'}
    have = {c for r in real_rows for c in COLS if c not in skip and r.get(c) not in (None, '')}
    b = base.get(pid, {})
    def bl(k, dflt): return b[k]['mean'] if k in b and b[k]['n'] >= 3 else dflt
    hr0, sb0, db0 = bl('heart_rate', 69 + rnd.uniform(-6, 6)), bl('systolic_bp', 116 + rnd.uniform(-6, 6)), bl('diastolic_bp', 70 + rnd.uniform(-4, 4))
    rr0, tp0 = bl('resp_rate', 16.5), bl('body_temp', 36.6)
    anchor = ('anchored to ' + src) if b and not pid.startswith('SIM') else 'anchored to the NASA bed-rest crew average'
    out = []
    g = lambda sd: rnd.gauss(0, sd)
    def row(md, hhmm, **vals):
        d = dt.date(2026, 1, 1) + dt.timedelta(days=md + 100)          # nominal date; import places rows by mission_day
        r = {c: '' for c in COLS}
        r.update(time_gmt=d.isoformat() + 'T' + hhmm + ':00Z', astronaut=name, agency=agency, role=role,
                 phase='baseline' if md <= 0 else 'mission', mission_day=str(md), data_type='simulated', source='SIMULATED filler · ' + anchor)
        r.update(vals); out.append(r)
    for md in range(MD_FROM, MD_TO + 1):
        day, fl = md - MD_FROM, max(0, md) / 60.0                       # slow drift over the mission
        v = {}
        if 'heart_rate' not in have: v['heart_rate'] = fmt(hr0 + 3 * fl + g(3), 0)
        if 'bp_systolic' not in have: v['bp_systolic'] = fmt(sb0 - 3 * fl + g(4), 0); v['bp_diastolic'] = fmt(db0 - 1.5 * fl + g(3), 0)
        if 'resp_rate' not in have: v['resp_rate'] = fmt(rr0 + g(0.8), 0)
        if 'temp_c' not in have: v['temp_c'] = fmt(tp0 + 0.15 * fl + g(0.12), 1)
        if 'spo2' not in have: v['spo2'] = fmt(min(100, 98 + g(0.7)), 0)
        if 'sleep_hours' not in have:
            v['sleep_hours'] = fmt(5.6 + rnd.uniform(0, 0.3) if day % 17 == 9 else 6.9 - 0.4 * fl + g(0.45), 1)
        if v: row(md, '06:00', **v)
        if 'glucose_mgdl' not in have: row(md, '06:30', glucose_mgdl=fmt(90 + 2 * fl + g(5), 0))
        if md >= 1:
            row(md, '08:00', mood_0_10=fmt(min(10, max(4, 7.5 - 0.8 * fl + g(0.8))), 0), symptom_suspected_infection='0', symptom_confusion='0',
                symptom_fainting='0', symptom_chest_pain='0')
            row(md, '19:00', exercise_pct=fmt(min(100, max(55, 92 + g(8))), 0))
            if 'radiation_dose_pct' not in have: row(md, '12:00', radiation_dose_pct=fmt(md * 0.3, 2))   # ~1.8 mSv/day on a Mars transit = 0.3 % of 600 mSv
        if day % 3 == 0 and 'fluid_intake_l' not in have:
            row(md, '21:00', fluid_intake_l=fmt(2.2 + rnd.uniform(0, 0.2) if day % 19 == 7 else 2.9 + g(0.25), 1))
        if md % 7 == 0:                                                    # weekly checks, normal results
            row(md, '10:00', ecg_irregular='0', ecg_no_p_waves='0', ecg_seconds='60', ecg_unstable='0')
            row(md, '10:15', ortho_lying_sbp=fmt(sb0 + g(3), 0), ortho_lying_dbp=fmt(db0 + g(2), 0), ortho_standing_sbp=fmt(sb0 - 6 + g(3), 0),
                ortho_standing_dbp=fmt(db0 - 2 + g(2), 0), ortho_minutes='3', syncope='0')
            row(md, '07:30', urine_24h_l=fmt(2.9 + g(0.25), 1), urine_blood='0', kidney_ultrasound='none')
            if md % 14 == 0:
                row(md, '11:00', ijv_velocity_cm_s=fmt(22 + g(3), 0), ijv_retrograde='0', ijv_thrombus='0')
                row(md, '11:30', sans_delta_trt_um=fmt(max(0, 2 + 0.12 * max(0, md) + g(2)), 0), sans_frisen_grade='0',
                    sans_refraction_shift_d=fmt(max(0, 0.004 * max(0, md) + g(0.05)), 2), sans_folds='none', sans_globe_flattening='none')
            if 'wbc_k_per_ul' not in have:
                row(md, '07:45', wbc_k_per_ul=fmt(6.2 + g(0.9), 1), platelets_k_per_ul=fmt(250 + g(30), 0), lymphocytes_per_ul=fmt(1900 + g(250), 0))
    return sorted(out, key=lambda r: (int(r['mission_day']), r['time_gmt']))


def baselines():
    base = collections.defaultdict(dict)
    with open(os.path.join(SRC, 'personal_baselines.csv'), encoding='utf-8-sig') as f:
        for x in csv.DictReader(f):
            m, n = fnum(x['mean']), fnum(x['n'])
            if m is not None:
                base[x['participant_id']][x['parameter_id']] = {'mean': m, 'n': int(n or 0), 'sd': fnum(x['sd'])}
    return base


def write(path, rows, cols=COLS, dtype=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if dtype and 'data_type' in cols:
        for r in rows:
            r.setdefault('data_type', dtype)
            if not r['data_type']: r['data_type'] = dtype
    for r in rows:
        for c in ('note', 'source'):
            if r.get(c):
                r[c] = r[c].replace(', ', '; ').replace(',', ';')
    with open(path, 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in rows:
            w.writerow({c: r.get(c, '') for c in cols})
    print('%6d rows  %s' % (len(rows), os.path.relpath(path, OUT)))


def main():
    obs, base = load(), baselines()
    files = {'sarah': 'sarah_nasa-bedrest_C3C_7352.csv', 'maya': 'maya_nasa-bedrest_C3C_7772.csv', 'david': 'david_nasa-bedrest_C3E_6043.csv',
             'elena': 'elena_nasa-bedrest_C3D_8615.csv', 'marcus': 'marcus_inspiration4_C001.csv', 'mei': 'mei_inspiration4_C002.csv',
             'robert': 'robert_inspiration4_C003.csv', 'amara': 'amara_inspiration4_C004.csv', 'john': 'john_csa-biomonitor_simulated.csv'}
    for key, fn in files.items():
        pid = CREW[key][3]
        rows = i4_file(key, obs[pid]) if pid.startswith('I4_') else csa_file(key, obs[pid]) if pid.startswith('SIM') else bedrest_file(key, obs[pid])
        write(os.path.join(OUT, 'crew', fn), rows, dtype='simulated' if pid.startswith('SIM') else 'real')
    d1, d2 = build_demos(sim_series(obs['SIM_CSA-Astro-01']), base)
    write(os.path.join(OUT, 'demo', 'demo_sarah_red-alert.csv'), d1, dtype='simulated')
    write(os.path.join(OUT, 'demo', 'demo_marcus_caution.csv'), d2, dtype='simulated')
    # simulated filler for the measurements each crew member is missing (Elena and Mei stay real-only)
    for key in SIM_FILL:
        pid = CREW[key][3]
        real = i4_file(key, obs[pid]) if pid.startswith('I4_') else csa_file(key, obs[pid]) if pid.startswith('SIM') else bedrest_file(key, obs[pid])
        write(os.path.join(OUT, 'crew-simulated', key + '_simulated.csv'), sim_fill(key, real, base), dtype='simulated')

    # reference tables
    os.makedirs(os.path.join(OUT, 'reference'), exist_ok=True)
    with open(os.path.join(SRC, 'reference_ranges.csv'), encoding='utf-8-sig') as f, \
         open(os.path.join(OUT, 'reference', 'charm_reference_ranges.csv'), 'w', newline='', encoding='utf-8') as g:
        g.write(f.read())
    print('  copy  reference/charm_reference_ranges.csv')
    avg = []
    for k, cap, gap in [('heart_rate', 15, 5), ('systolic_bp', 11, 5), ('diastolic_bp', 10, 5), ('resp_rate', 1.4, 2), ('body_temp', 0.4, 0.5)]:
        vals = [b[k]['mean'] for p, b in base.items() if k in b and b[k]['n'] >= 3 and not p.startswith('SIM')]
        avg.append({'metric': k, 'crew_average': round(statistics.mean(vals), 2), 'between_person_sd': round(statistics.pstdev(vals), 2),
                    'n_people': len(vals), 'offset_cap': cap, 'gap_to_critical': gap,
                    'source': 'personal_baselines.csv (pre-bed-rest values, NASA bed rest C1/C3/C11)'})
    write(os.path.join(OUT, 'reference', 'crew_average_baselines.csv'), avg,
          ['metric', 'crew_average', 'between_person_sd', 'n_people', 'offset_cap', 'gap_to_critical', 'source'])
    pb = []
    for key, (name, ag, role, pid, src) in CREW.items():
        for k in ['heart_rate', 'systolic_bp', 'diastolic_bp', 'resp_rate', 'body_temp']:
            b = base.get(pid, {}).get(k)
            if b:
                pb.append({'astronaut': name, 'source_person': pid, 'metric': k, 'n': b['n'], 'mean': round(b['mean'], 2),
                           'sd': '' if b['sd'] is None else round(b['sd'], 2)})
    write(os.path.join(OUT, 'reference', 'crew_personal_baselines.csv'), pb, ['astronaut', 'source_person', 'metric', 'n', 'mean', 'sd'])


if __name__ == '__main__':
    main()
