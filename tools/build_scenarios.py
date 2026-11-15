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
    rank = {'NORMAL': 0, 'ATTENTION': 1, 'ALERT': 1, 'CAUTION': 2, 'CRITICAL': 3}
    for i, st in enumerate(sc['stages']):
        st['n'] = i + 1
        st['code'] = st.get('code') or code_of(st['label'])
        lab = st['label'].upper()
        st['down'] = i == 0 or (prev is not None and not st.get('branch') and (
            rank[st['code']] < rank[prev] or any(w in lab for w in ('RECOVER', 'RESOLV', 'MONITORING', 'STABLE', 'FOLLOW-UP'))))
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


# ---------------------------------------------------------------- 5. Bleeding emergency (medic team, app-ready CSV)
# Stage values, statuses and text: the medic team's CSV. Added on top, clearly labelled: the first-aid steps of
# Stop the Bleed (American College of Surgeons), which the team's "approved first-aid bleeding-control steps" refer to.
FIRST_AID = {
    2: 'Put on gloves and eye protection (blood floats); Press firmly on the wound with gauze and both hands; Do not lift the dressing to look',
    3: 'Keep firm pressure; If blood soaks through: pack the wound with gauze and press, or for an arm or leg place a tourniquet 5-8 cm above the wound, never on a joint, if the kit has one; Write down the time a tourniquet goes on',
    4: 'Keep the pressure or the tourniquet on; Keep Sarah lying down, anchored and warm',
    5: 'Keep the pressure or the tourniquet on; Lie her flat and keep her warm',
}
BLEED_STATE = {1: 'none', 2: 'ongoing', 3: 'ongoing', 4: 'ongoing', 5: 'ongoing', 7: 'controlled', 8: 'none'}
DIZZY = {4: 'mild', 5: 'severe', 7: 'mild'}


def bleeding():
    st = []
    rows_csv = read('bleeding_emergency_scenario.csv')
    assert [int(r['stage_id']) for r in rows_csv] == list(range(1, 9)), 'bleeding CSV: stages 1-8 in order'
    for r in rows_csv:
        n = int(r['stage_id'])
        assert not r['hemoglobin_g_dL'] and not r['hematocrit_percent'], 'bleeding CSV: lab columns must stay empty'
        v = vit(hr=num(r['heart_rate_bpm']), sbp=num(r['systolic_bp_mmHg']), dbp=num(r['diastolic_bp_mmHg']),
                rr=num(r['respiratory_rate_per_min']), spo2=num(r['spo2_percent']))
        if v.get('hr') and v.get('sbp'):
            v['si'] = round(v['hr'] / v['sbp'], 2)
        rows = vital_rows(v)
        if v:
            rows.append({'k': 'sym', 'x': {'bleed': BLEED_STATE.get(n, 'none'), 'dizzy': DIZZY.get(n, 'none'), 'inf': False, 'conf': False}})
        fa = FIRST_AID.get(n, '')
        st.append(dict(label=r['charm_status'], code=r['status_code'], stage=r['stage_label'] + ' · ' + r['observation_window'],
                       what=r['sarah_condition'], symptoms=r['symptoms'],
                       key=(('HR %g bpm · BP %g/%g mmHg · RR %g/min · SpO2 %g%%' % (v['hr'], v['sbp'], v['dbp'], v['rr'], v['spo2'])) if v.get('hr') else r['last_known_measurements_note']),
                       report=[['Bleeding observed?', 'Yes (crew report)' if r['bleeding_reported_by_crew'].strip().lower() == 'true' else 'No'],
                               ['Bleeding', r['bleeding_observation']], ['Control', r['bleeding_control_status']], ['Symptoms', r['symptoms']],
                               ['Sources', r['measurement_sources']]],
                       alertTitle=r['alert_title'], basis=r['alert_basis'], trend=r['trend_direction'],
                       assess=r['charm_assessment'], checks=r['required_checks'], labs=r['laboratory_tests'],
                       actions=r['immediate_action_steps'] + ('; ' + fa if fa else ''), firstaid=fa, equip=r['equipment'], treat=r['treatment_guidance'],
                       v=v, rows=rows, earth=r['earth_link_unavailable'].strip().lower() == 'true'))
    return finish(dict(id='bleed', title='Bleeding Emergency during a Mars Mission', kind='Emergency', file='bleeding_emergency_scenario.csv',
                       sub='Sarah · maintenance injury · crew-reported bleeding, falling blood pressure, emergency response and recovery',
                       time='Named observation windows, not clock times.',
                       m=[['hr', 'Heart rate', 'bpm', 0], ['bp', 'Blood pressure', 'mmHg', 0], ['si', 'Shock index (HR ÷ systolic)', '', 2], ['rr', 'Respiratory rate', '/min', 0], ['spo2', 'SpO₂', '%', 0]],
                       demo=['All numbers are simulated demo values from the medic team, not NASA participant recordings.',
                             'Bleeding is a crew report, not a sensor reading: CHARM cannot detect bleeding or estimate blood loss. A normal SpO2 does not rule out serious blood loss, and hemoglobin can stay normal early, so no lab values are shown.',
                             'First-aid steps added to the action cards follow Stop the Bleed (American College of Surgeons): firm pressure, packing, a tourniquet 5-8 cm above an arm or leg wound, never on a joint, and the time noted.',
                             'Stage 5 is CRITICAL because of continuing bleeding with systolic pressure 86 and near-fainting, not because of the heart rate alone.'],
                       stages=st))


# ---------------------------------------------------------------- 7. Airborne exposure / respiratory emergency (medic team)
AIRWAY = {1: 'none', 2: 'irritation', 3: 'wheeze', 4: 'moderate', 5: 'severe', 7: 'wheeze', 8: 'none'}
ORIGIN = {'real_NASA_ground_analog_baseline_mean_rounded': 'NASA ground analog mean', 'synthetic_demo': 'synthetic', 'missing_no_new_measurement': 'no new measurement'}


def airborne():
    st = []
    rows_csv = read('airborne_allergy_emergency_scenario.csv')
    assert [int(r['stage_id']) for r in rows_csv] == list(range(1, 9)), 'airborne CSV: stages 1-8 in order'
    for r in rows_csv:
        n = int(r['stage_id'])
        v = vit(hr=num(r['heart_rate_bpm']), sbp=num(r['systolic_bp_mmHg']), dbp=num(r['diastolic_bp_mmHg']),
                rr=num(r['respiratory_rate_per_min']), spo2=num(r['spo2_percent']), temp=num(r['body_temperature_c']))
        rows = vital_rows(v)
        if v:
            rows.append({'k': 'sym', 'x': {'airway': AIRWAY.get(n, 'none'), 'expo': r['crew_reported_suspected_exposure'].strip().lower() == 'true' and n < 8, 'inf': False, 'conf': False}})
        link = r['earth_link_status'].strip().upper()
        st.append(dict(label=r['charm_status'], code=r['status_code'], stage=r['stage_label'] + ' · ' + r['observation_window'],
                       what=r['sarah_condition'], symptoms=r['symptoms'],
                       key=(('HR %g bpm · BP %g/%g mmHg · RR %g/min · SpO2 %g%% · %g °C' % (v['hr'], v['sbp'], v['dbp'], v['rr'], v['spo2'], v['temp'])) if v.get('hr') else 'No new measurements. Stage 5 values are LAST KNOWN and STALE.'),
                       report=[['Cabin incident', r['cabin_incident_report']], ['Environment evidence', r['environment_evidence']], ['Suspected trigger', r['suspected_trigger']],
                               ['Breathing', r['breathing_symptoms']], ['Skin and eyes', r['skin_or_eye_symptoms']], ['Diagnosis', r['diagnosis_confirmation']]],
                       prov={'hr': ORIGIN.get(r['heart_rate_origin'], r['heart_rate_origin']), 'bp': ORIGIN.get(r['bp_origin'], r['bp_origin']), 'rr': ORIGIN.get(r['resp_rate_origin'], r['resp_rate_origin']),
                             'spo2': ORIGIN.get(r['spo2_origin'], r['spo2_origin']), 'temp': ORIGIN.get(r['temperature_origin'], r['temperature_origin'])},
                       alertTitle=r['alert_title'], basis=r['alert_basis'],
                       assess=r['charm_assessment'], checks=r['required_checks'], labs=r['laboratory_tests'],
                       actions=r['immediate_action_steps'], equip=r['equipment'], treat=r['treatment_guidance'],
                       v=v, rows=rows, earth=r['earth_link_unavailable'].strip().lower() == 'true', restored=link == 'RESTORED', link=link))
    return finish(dict(id='air', title='Airborne Exposure / Respiratory Emergency', kind='Emergency', file='airborne_allergy_emergency_scenario.csv',
                       sub='Sarah · cabin air-filter seal fails · possible allergic or irritant airway reaction, severe breathing difficulty and recovery',
                       time='Named observation windows, not clock times.',
                       m=[['hr', 'Heart rate', 'bpm', 0], ['rr', 'Respiratory rate', '/min', 0], ['spo2', 'SpO₂', '%', 0], ['bp', 'Blood pressure', 'mmHg', 0], ['temp', 'Temperature', '°C', 1]],
                       prov='Stage 1 HR, BP, RR and temperature are rounded pre-bed-rest means of NASA NLSP CFT70 ground bed-rest analog subject C11_CFT70_8072 (CRF_CFT70_VITALS_8072, DOI 10.83263/wjw1-ta27; HR 76.4, BP 118.2/74.4, RR 16.4, 36.62 °C), a ground study, not flight data. SpO2 is synthetic in every stage; all stage 2-8 values and the incident are synthetic.',
                       demo=['The exposure and the symptoms are crew reports. CHARM cannot detect or identify an allergen and does not diagnose allergy, asthma or anaphylaxis: "possible allergic or irritant airway reaction" until the Crew Medical Officer assesses it.',
                             'Severity follows the NAEPP asthma-exacerbation grades: moderate = speaks in phrases, heart rate 100-120; severe = cannot finish sentences, heart rate over 120, breathing over 30/min.',
                             'CHARM\'s own breathing-rate rule (NEWS2: 25/min or more) already raises a CRITICAL alert at stage 4, one stage before the scenario\'s authored CRITICAL.'],
                       stages=st))


# ---------------------------------------------------------------- 6. Cardiac arrhythmia (medic team, app-ready CSV)
def arrhythmia():
    st = []
    rows_csv = read('arrhythmia_scenario.csv')
    assert [int(r['stage_id']) for r in rows_csv] == list(range(1, 9)), 'arrhythmia CSV: stages 1-8 in order'
    for r in rows_csv:
        n = int(r['stage_id'])
        v = vit(hr=num(r['heart_rate_bpm']), sbp=num(r['systolic_bp_mmHg']), dbp=num(r['diastolic_bp_mmHg']),
                rr=num(r['respiratory_rate_per_min']), spo2=num(r['spo2_min_percent']), spo2b=num(r['spo2_max_percent']))
        rows = vital_rows(v)
        pp, ecg = r['pulse_pattern'], r['ecg_status']
        irr = 'rregular' in pp and 'Regular' != pp
        for x in rows:
            if x['k'] == 'hr' and irr: x['irr'] = True
        sy = r['symptoms'].lower()
        if v:
            rows.append({'k': 'sym', 'x': {'palp': 'palpitation' in sy and 'resolved' not in sy, 'dizzy': 'severe' if 'severe' in sy else 'mild' if ('dizz' in sy or 'lightheaded' in sy) and 'no dizziness' not in sy and 'resolved' not in sy else 'none', 'inf': False, 'conf': False}})
        # ECG: a clinician-reviewed or baseline ECG is an exam result; a screening flag or a request is not
        if 'Sinus rhythm' in ecg or 'sinus rhythm' in ecg:
            rows.append({'k': 'ecg', 'x': {'irr': False, 'sec': 60}})
        elif 'reviewed' in ecg and 'atrial fibrillation' in ecg:
            rows.append({'k': 'ecg', 'x': {'irr': True, 'noP': True, 'sec': 60}})
        evid = ('BASELINE ECG' if n == 1 else 'SCREENING FLAG' if 'Not yet obtained' in ecg else 'ECG REQUESTED' if 'requested' in ecg
                else 'CLINICIAN-REVIEWED ECG' if 'reviewed by Crew Medical Officer' in ecg or 'Previously reviewed' in ecg
                else 'NO NEW SAMPLE' if 'no new' in ecg.lower() else 'FOLLOW-UP ECG PENDING' if 'pending' in ecg else 'FOLLOW-UP ECG REVIEWED')
        st.append(dict(label=r['charm_status'], code=r['status_code'], stage=r['stage_label'] + ' · ' + r['observation_window'],
                       what=r['sarah_condition'], symptoms=r['symptoms'], key=(('HR %g bpm · BP %g/%g mmHg · RR %g/min · SpO2 %g%%' % (v['hr'], v['sbp'], v['dbp'], v['rr'], v['spo2'])) if v else r['last_known_measurements_note']),
                       pulse=pp, ecg=ecg, evid=evid, alertTitle=r['alert_title'], basis=r['alert_basis'], trend=r['trend_direction'],
                       assess=r['charm_assessment'], checks=r['required_checks'], labs=r['laboratory_tests'],
                       actions=r['immediate_action_steps'], equip=r['equipment'], treat=r['treatment_guidance'],
                       v=v, rows=rows, earth=r['earth_link_unavailable'].strip().lower() == 'true'))
    return finish(dict(id='arr', title='Cardiac Arrhythmia during a Mars Mission', kind='Emergency', file='arrhythmia_scenario.csv',
                       sub='Sarah · Mars transit · irregular pulse to clinician-reviewed atrial fibrillation, instability and recovery',
                       time='Named observation windows, not clock times.',
                       m=[['hr', 'Heart rate', 'bpm', 0], ['bp', 'Blood pressure', 'mmHg', 0], ['rr', 'Respiratory rate', '/min', 0], ['spo2', 'SpO₂', '%', 0]],
                       demo=['All stage values are synthetic illustrative values from the medic team, not a NASA patient record and not ECG signal data.',
                             'There is no ECG recording in our data. Pulse, blood pressure and symptoms are a first indication and set the urgency: a fast irregular pulse with dizziness and falling blood pressure raises the alert and asks for an ECG. The rhythm is named only from the medical officer\'s reading of that ECG (entered as a result, not a trace). Later, if needed, a heart ultrasound (echocardiography) checks the heart\'s structure and function.',
                             'A wearable irregular pulse is a screening flag only. Atrial fibrillation is shown only after the Crew Medical Officer reviews an ECG (stage 4). CHARM does not diagnose a rhythm or choose drugs or doses.',
                             'Stage 5 is CRITICAL because Sarah is hypotensive and severely dizzy with the abnormal rhythm (AHA tachyarrhythmia algorithm: hypotension, altered mental status, signs of shock, ischemic chest discomfort or acute heart failure), not because of a heart-rate number.'],
                       stages=st))


def main():
    sc = [bleeding(), arrhythmia(), airborne(), pulmonary(), dehydration(), sans(), bone()]
    js = ('/* GENERATED by tools/build_scenarios.py from data/scenarios/*.csv (medic team). Do not edit by hand. */\n'
          'window.CHARM_SCENARIOS = ' + json.dumps(sc, ensure_ascii=False, indent=0) + ';\n')
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(js)
    for s in sc:
        print(s['id'], len(s['stages']), 'stages:', ' '.join('%d:%s%s' % (x['n'], x['code'][0], 'v' if x['down'] else '') for x in s['stages']))


if __name__ == '__main__':
    main()
