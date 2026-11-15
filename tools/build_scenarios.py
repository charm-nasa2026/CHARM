"""Build public/js/scenarios.js from the medic team's scenario CSV files in data/scenarios/.

Every text shown in the app comes from the CSV. The `rows` of each stage are the measurements that
"Run live" writes into the astronaut's file (marked DEMO), so CHARM's own alert engine raises the alerts.
They are taken from the CSV numbers; where the CSV gives no number (fluid intake "below target",
"stable" eye findings) the value used is listed in DEMO_VALUES below and shown in the app as a demo value.

Run:  python3 tools/build_scenarios.py
"""
import csv, json, os, re

ROOT = os.path.join(os.path.dirname(__file__), '..')
SRC = os.path.join(ROOT, 'data', 'scenarios')
OUT = os.path.join(ROOT, 'public', 'js', 'scenarios.js')


def read(name):
    with open(os.path.join(SRC, name), encoding='utf-8-sig', newline='') as f:
        return list(csv.DictReader(f))


def code_of(label):
    u = label.upper()
    if 'CRITICAL' in u:
        return 'CRITICAL'
    if u.startswith('NORMAL'):
        return 'NORMAL'
    return 'ALERT'


def num(s):
    s = (s or '').strip()
    return None if s == '' else float(s)


def vit(**kw):
    return {k: v for k, v in kw.items() if v is not None}


def nums(text):
    """HR 94 | BP 110/72 | RR 20 | SpO2 99% | Shock index 0.85 -> dict"""
    out = {}
    m = re.search(r'HR (\d+)', text);            out['hr'] = float(m.group(1)) if m else None
    m = re.search(r'BP (\d+)/(\d+)', text)
    if m: out['sbp'], out['dbp'] = float(m.group(1)), float(m.group(2))
    m = re.search(r'RR (\d+)', text);            out['rr'] = float(m.group(1)) if m else None
    m = re.search(r'SpO2 (\d+)', text);          out['spo2'] = float(m.group(1)) if m else None
    m = re.search(r'Shock index ([\d.]+)', text); out['si'] = float(m.group(1)) if m else None
    return {k: v for k, v in out.items() if v is not None}


def vital_rows(v):
    rows = []
    for k in ('temp', 'hr', 'rr', 'spo2'):
        if v.get(k) is not None:
            rows.append({'k': k, 'v': v[k]})
    if v.get('sbp') is not None:
        rows.append({'k': 'bp', 'v': v['sbp'], 'v2': v['dbp']})
    return rows


def finish(sc):
    """down = this stage should clear alerts that are no longer met (recovery)."""
    prev = None
    rank = {'NORMAL': 0, 'ALERT': 1, 'CRITICAL': 2}
    for i, st in enumerate(sc['stages']):
        st['n'] = i + 1
        st['code'] = code_of(st['label'])
        lab = st['label'].upper()
        st['down'] = i == 0 or (prev is not None and not st.get('branch') and (
            rank[st['code']] < rank[prev] or any(w in lab for w in ('RECOVER', 'RESOLV', 'MONITORING', 'STABLE'))))
        if not st.get('branch') and not st.get('earth'):
            prev = st['code']
    return sc


# ---------------------------------------------------------------- 1. Pulmonary infection (acute, 8 stages)
def pulmonary():
    st = []
    for r in read('pulmonary_infection_scenario.csv'):
        n = int(r['stage_id'])
        v = vit(temp=num(r['temperature_c']), hr=num(r['heart_rate_bpm']), rr=num(r['respiratory_rate_per_min']),
                sbp=num(r['systolic_bp_mmHg']), dbp=num(r['diastolic_bp_mmHg']), spo2=num(r['spo2_min_percent']),
                spo2b=num(r['spo2_max_percent']))
        rows = vital_rows(v)
        # symptom check from the CSV text: respiratory symptoms (stage 3 on), difficulty concentrating (stage 5)
        if n in (2, 3, 4, 5, 7):  # 2: 'possible sore throat'
            rows.append({'k': 'sym', 'x': {'inf': True, 'conf': n == 5}})
        if n in (1, 8):
            rows.append({'k': 'sym', 'x': {'inf': False, 'conf': False}})
        st.append(dict(label=r['C.H.A.R.M. status'], stage=r['Stage'], what=r['What happens to Sarah'],
                       key=r['Key measurements'], assess=r['C.H.A.R.M. assessment'], checks=r['Checks requested by C.H.A.R.M.'],
                       labs=r['Blood / lab tests'], actions=r['Immediate action steps'], equip=r['Equipment'],
                       treat=r['Treatment guidance'], v=v, rows=rows if v else [], earth=n == 6))
    return finish(dict(id='pulm', title='Pulmonary Infection in Space', kind='Acute', file='pulmonary_infection_scenario.csv',
                       sub='Sarah · Flight Engineer · mid-Mars transit · respiratory infection to CRITICAL and back',
                       time='The stages are a demonstration sequence, not a real-time disease timeline.',
                       m=[['temp', 'Temperature', '°C', 1], ['hr', 'Heart rate', 'bpm', 0], ['rr', 'Respiratory rate', '/min', 0],
                          ['bp', 'Blood pressure', 'mmHg', 0], ['spo2', 'SpO₂', '%', 0]],
                       demo=[], stages=st))


# ---------------------------------------------------------------- 2. Dehydration (acute, 10 steps)
def dehydration():
    st = []
    for r in read('dehydration_scenario.csv'):
        n = int(r['step_order'])
        v = nums(r['key_measurements'])
        rows = vital_rows(v)
        if n == 1:   # "Fluid intake below 2.5 L/day target" (no number in the source)
            v['fluid'] = 1.6; rows.append({'k': 'fluid', 'v': 1.6})
        if n == 10:  # "Fluid intake back on target | HR and BP at baseline" -> step 2 values
            v.update(fluid=2.8, hr=76, sbp=116, dbp=74, si=0.66)
            rows = vital_rows(v) + [{'k': 'fluid', 'v': 2.8}]
        branch = n == 6
        st.append(dict(label=r['charm_status'], stage=r['stage'], what=r['what_happens'], key=r['key_measurements'],
                       assess=r['charm_assessment'], checks=r['checks_requested'], labs=r['blood_lab_tests'],
                       actions=r['immediate_action_steps'], equip=r['equipment'], treat=r['treatment_guidance'],
                       v=v, rows=rows, earth=n == 7, branch=branch))
    return finish(dict(id='dehy', title='Dehydration during a Mars Mission', kind='Acute', file='dehydration_scenario.csv',
                       sub='Sarah · busy workday with exercise · fluid deficit to low blood volume (shock index) and back',
                       time='Minutes 0 to 30 and the following hours, played as a demonstration sequence.',
                       m=[['hr', 'Heart rate', 'bpm', 0], ['bp', 'Blood pressure', 'mmHg', 0], ['si', 'Shock index (HR ÷ systolic)', '', 2],
                          ['rr', 'Respiratory rate', '/min', 0], ['fluid', 'Fluid intake', 'L/day', 1]],
                       demo=['Fluid intake 1.6 L/day (step 1) and 2.8 L/day (step 10) are demo values: the source says "below the 2.5 L/day target" and "back on target".',
                             'Step 10 uses the step 2 vital signs for "HR and BP at baseline".'],
                       stages=st))


# ---------------------------------------------------------------- 3. SANS (chronic, weeks to months)
SANS_X = {
    1: {'trt': 0, 'refr': 0, 'folds': 'none', 'flat': 'none', 'frisen': 0},
    2: {'trt': 8, 'refr': 0, 'folds': 'none'},
    3: {'trt': 22, 'refr': 0.25, 'folds': 'none'},
    4: {'trt': 38, 'refr': 0.75, 'folds': 'any'},
    5: {'trt': 58, 'refr': 0.75, 'folds': 'any', 'frisen': 1, 'flat': 'moderate'},
    8: {'trt': 58, 'refr': 0.75, 'folds': 'any', 'stable': True},
    9: {'trt': 56, 'refr': 0.75, 'folds': 'any', 'stable': True},
}


def sans():
    st = []
    for r in read('sans_scenario.csv'):
        n = int(r['step_order'])
        x = SANS_X.get(n)
        v = {}
        if x:
            v = {'trt': x['trt'], 'refr': x.get('refr')}
        st.append(dict(label=r['charm_status'], stage=r['stage'], what=r['what_happens'], key=r['key_measurements'],
                       assess=r['charm_assessment'], checks=r['checks_requested'], labs=r['eye_tests_imaging'],
                       labsTitle='EYE TESTS AND IMAGING', actions=r['immediate_action_steps'], equip=r['equipment'],
                       treat=r['treatment_guidance'], v=v, rows=[{'k': 'vision', 'x': x}] if x else [],
                       earth=n == 6, branch=n == 7))
    return finish(dict(id='sans', title='Vision Changes during a Mars Mission (SANS)', kind='Chronic', file='sans_scenario.csv',
                       sub='Sarah, 35 · weeks to months of fluid shift · optic disc swelling (NASA SANS criteria) and follow-up',
                       time='Weeks and months in the source, played in seconds here.',
                       m=[['trt', 'ΔTRT (optic disc thickness vs pre-flight)', 'µm', 0], ['refr', 'Refraction shift', 'D', 2]],
                       demo=['Weeks 12–16 and months 4–6: ΔTRT 58 and 56 µm (source: "+55 to +60 µm, not rising" and "stable or slowly falling") with an ophthalmology "reviewed, not rising" flag.',
                             'Steps 9 and 10 (before landing, after return) add no new values; the last ones stay.'],
                       stages=st))


# ---------------------------------------------------------------- 4. Bone health (chronic, 7 stages)
def bone():
    st = []
    for r in read('bone_health_chronic_scenario.csv'):
        n = int(r['stage_id'])
        ntx, oc, bs = num(r['ntx_nM_BCE_per_mM_creatinine']), num(r['osteocalcin_ng_per_mL']), num(r['bsap_ug_per_L'])
        v = vit(ntx=ntx, oc=oc, bsap=bs)
        rows = []
        if ntx is not None:
            x = {'ntx': ntx, 'oc': oc, 'bsap': bs}
            if n >= 5:
                x['follow'] = True   # "do not clear the warning merely because the unloading phase ended"
            rows = [{'k': 'bone', 'x': x}]
        st.append(dict(label=r['status_label'], stage=r['stage'] + ' · ' + r['timeline_label'], what=r['symptoms_and_context'],
                       key=(r['source_analog_label'] + (' · NTX %g · osteocalcin %g · BSAP %g' % (ntx, oc, bs) if ntx is not None else '')),
                       assess=r['charm_assessment'], checks=r['checks_requested'], labs=r['blood_or_urine_tests'],
                       actions=r['immediate_actions'], equip=r['equipment'], treat=r['treatment_guidance'],
                       v=v, rows=rows, earth=r['earth_communication'] == 'UNAVAILABLE', disclaimer=r['data_disclaimer']))
    return finish(dict(id='bone', title='Bone Health · Chronic Monitoring', kind='Chronic', file='bone_health_chronic_scenario.csv',
                       sub='Sarah · bone-turnover markers over a long mission (real bed-rest analog values, participant C3D_7984)',
                       time='Pre-mission to post-mission follow-up, played in seconds here.',
                       m=[['ntx', 'Urine NTX (bone breakdown)', 'nM BCE/mM Cr', 0], ['oc', 'Osteocalcin', 'ng/mL', 1], ['bsap', 'BSAP (bone formation)', 'µg/L', 1]],
                       demo=['CHARM flags NTX 30 % or more above the pre-mission value as WATCH, and keeps the flag while clinician follow-up is pending. This is a demo rule, not a validated clinical cutoff.',
                             'Biomarker values: one real anonymized ground-based bed-rest participant (C3D_7984). No DXA or bone density value is shown.'],
                       stages=st))


def main():
    sc = [pulmonary(), dehydration(), sans(), bone()]
    js = ('/* GENERATED by tools/build_scenarios.py from data/scenarios/*.csv (medic team). Do not edit by hand. */\n'
          'window.CHARM_SCENARIOS = ' + json.dumps(sc, ensure_ascii=False, indent=0) + ';\n')
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(js)
    for s in sc:
        print(s['id'], len(s['stages']), 'stages:', ' '.join('%d:%s%s' % (x['n'], x['code'][0], 'v' if x['down'] else '') for x in s['stages']))


if __name__ == '__main__':
    main()
