import os, re, io, json, math, sqlite3, traceback
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

from flask import Flask, render_template, request, jsonify
from dotenv import load_dotenv
from werkzeug.exceptions import HTTPException

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / '.env')

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 12 * 1024 * 1024
DB = BASE_DIR / 'career_match.db'

MODEL = os.getenv('GEMINI_MODEL', 'gemini-3.8-flash').strip()
FALLBACK_MODELS = [m.strip() for m in os.getenv('GEMINI_FALLBACK_MODELS', 'gemini-2.5-flash,gemini-2.0-flash').split(',') if m.strip()]
MODELS = [MODEL] + [m for m in FALLBACK_MODELS if m != MODEL]
EMBED_MODEL = os.getenv('EMBEDDING_MODEL', 'gemini-embedding-001').strip()
KEY = os.getenv('GEMINI_API_KEY', '').strip()
AI_TIMEOUT_MS = int(os.getenv('GEMINI_TIMEOUT_SECONDS', '45')) * 1000
if KEY in ('', 'your_api_key_here', 'your_actual_key'):
    KEY = ''

client = None
_bad_models = set()
_state = {'model': MODEL}

if KEY:
    try:
        from google import genai
        try:
            from google.genai import types as _types
            client = genai.Client(api_key=KEY, http_options=_types.HttpOptions(timeout=AI_TIMEOUT_MS))
        except Exception:
            client = genai.Client(api_key=KEY)
    except Exception as e:
        print('Gemini client unavailable:', e)


# --------------------------------------------------------------------------- skills
SKILL_PATTERNS = {
    'HTML': r'html\s?5?', 'CSS': r'css\s?3?', 'JavaScript': r'javascript|ecmascript|es6\+?|java script',
    'TypeScript': r'typescript', 'React': r'react(?:\.?js)?', 'Next.js': r'next\.?js', 'Node.js': r'node\.?js|node js',
    'Express': r'express(?:\.?js)?', 'Vue': r'vue(?:\.?js)?', 'Angular': r'angular(?:js)?',
    'Python': r'python', 'Flask': r'flask', 'Django': r'django', 'Java': r'java', 'C#': r'c#|c sharp', 'PHP': r'php',
    'Bootstrap': r'bootstrap', 'jQuery': r'jquery', 'Tailwind CSS': r'tailwind(?:\s?css)?', 'Sass': r'sass|scss',
    'Git': r'git', 'GitHub': r'github',
    'REST API': r'rest(?:ful)?(?:\s+web)?\s*apis?|restful',
    'API Integration': r'api integrations?|apis?\s+integrations?|integrat\w*\s+(?:with\s+|third[- ]party\s+)?(?:rest\s*)?apis?|consum\w+\s+(?:rest\s*)?apis?|fetch\w*\s+(?:data\s+)?from\s+(?:an?\s+)?apis?|rest(?:ful)?\s*apis?',
    'GraphQL': r'graphql',
    'SQL': r'(?:my|postgre|t-)?sql(?:ite)?', 'MongoDB': r'mongo(?:db)?', 'Firebase': r'firebase',
    'Figma': r'figma',
    'UI/UX': r'ui\s*/\s*ux|ui\s*&\s*ux|ux\s*/\s*ui|ui design|ux design|user interface design|user experience',
    'Responsive Design': r'responsive(?:ness)?(?:\s+(?:web|mobile|ui|design|development|layouts?|websites?|interfaces?|applications?|apps?))?|mobile[- ]first',
    'Accessibility': r'accessib\w*|wcag|a11y|aria',
    'Testing': r'testing|unit tests?|test cases?|test[- ]driven|tdd',
    'Jest': r'jest', 'Vitest': r'vitest', 'Playwright': r'playwright', 'Cypress': r'cypress',
    'Docker': r'docker', 'AWS': r'aws|amazon web services', 'Azure': r'azure', 'Linux': r'linux', 'CI/CD': r'ci\s*/\s*cd',
    'Communication': r'communication', 'Problem Solving': r'problem[- ]solving', 'Teamwork': r'team ?work|team player',
    'Agile': r'agile|scrum|kanban', 'SEO': r'seo',
    'Redux': r'redux', 'Vite': r'vite', 'Webpack': r'webpack', 'WordPress': r'wordpress',
    'Machine Learning': r'machine learning|ml', 'Data Analysis': r'data analysis|data analytics',
    'Prompt Engineering': r'prompt engineering', 'LLM': r'llms?|large language models?', 'Embeddings': r'embeddings?',
    'Vector Database': r'vector (?:database|db|store)s?', 'RAG': r'rag|retrieval[- ]augmented',
    'Function Calling': r'function[- ]calling|tool[- ]calling',
    # Electronics / electrical / embedded engineering skills
    'Circuit Design': r'circuit design|electronic circuit(?:s)?',
    'Circuit Simulation': r'circuit simulation|circuit simulator',
    'Power Electronics': r'power electronics|power converters?',
    'RF Engineering': r'\brf\b|radio frequency',
    'VLSI': r'\bvlsi\b|very large scale integration',
    'C++': r'c\+\+',
    'Embedded C': r'embedded c(?: programming)?',
    'Hardware Debugging': r'hardware debugging|hardware troubleshooting',
    'Electrical Testing': r'electrical testing|electronic testing',
    'Analog Electronics': r'analog electronics|analogue electronics|analog circuits?',
    'Digital Electronics': r'digital electronics|digital logic|logic circuits?',
    'PCB Design': r'pcb design|printed circuit boards?',
    'Microcontrollers': r'microcontrollers?|microcontroller programming',
    'Embedded Systems': r'embedded systems?|embedded firmware',
    'Arduino': r'arduino',
    'Raspberry Pi': r'raspberry pi',
    'FPGA': r'\bfpga\b|field programmable gate arrays?',
    'Verilog': r'\bverilog\b',
    'VHDL': r'\bvhdl\b',
    'MATLAB': r'\bmatlab\b',
    'Simulink': r'\bsimulink\b',
    'PLC': r'\bplc\b|programmable logic controllers?',
    'SCADA': r'\bscada\b',
    'Power Systems': r'power systems?|power distribution|power transmission',
    'Electrical Machines': r'electrical machines?|electric motors?|generators',
    'Control Systems': r'control systems?|feedback control',
    'Signal Processing': r'signal processing|digital signal processing|\bdsp\b',
    'Communication Systems': r'communication systems?|telecommunication(?:s)?',
    'Instrumentation': r'instrumentation|industrial instrumentation',
    'Sensors': r'sensors?|transducers?',
    'IoT': r'\biot\b|internet of things',
    'Semiconductor Devices': r'semiconductors?|diodes?|transistors?',
    'Oscilloscope': r'oscilloscopes?',
    'Multimeter': r'multimeters?',
    'Soldering': r'soldering|solder',
    'Proteus': r'\bproteus\b',
    'Altium Designer': r'altium(?: designer)?',
    'KiCad': r'\bkicad\b',
    'LTspice': r'ltspice',
    'AutoCAD Electrical': r'autocad electrical',
}
SKILL_RX = {name: re.compile(r'(?<![\w])(?:' + pat + r')(?![\w])', re.I) for name, pat in SKILL_PATTERNS.items()}


def found_skills(text):
    return sorted(name for name, rx in SKILL_RX.items() if rx.search(text or ''))


# --------------------------------------------------------------------------- database
SCHEMA = [
    'CREATE TABLE IF NOT EXISTS analyses(id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, company TEXT, score INTEGER, payload TEXT, created TEXT)',
    'CREATE TABLE IF NOT EXISTS chats(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, created TEXT, updated TEXT)',
    'CREATE TABLE IF NOT EXISTS chat_messages(id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, tool TEXT, created TEXT)',
    'CREATE INDEX IF NOT EXISTS idx_chat_messages_chat ON chat_messages(chat_id, id)',
]


@contextmanager
def get_db():
    c = sqlite3.connect(DB, timeout=15)
    c.row_factory = sqlite3.Row
    c.execute('PRAGMA foreign_keys=ON')
    for stmt in SCHEMA:  # cheap + makes the app self-heal if career_match.db is deleted while running
        c.execute(stmt)
    try:
        yield c
        c.commit()
    finally:
        c.close()


def init_db():
    with get_db():
        pass


def now():
    return datetime.now().strftime('%Y-%m-%d %H:%M:%S')


# --------------------------------------------------------------------------- files
def text_from_file(f):
    ext = Path(f.filename).suffix.lower()
    data = f.read()
    f.seek(0)
    if ext == '.txt':
        return data.decode('utf-8', errors='ignore')
    if ext == '.pdf':
        try:
            from pypdf import PdfReader
            text = '\n'.join(p.extract_text() or '' for p in PdfReader(io.BytesIO(data)).pages)
        except Exception:
            raise ValueError('PDF reading failed. Make sure this is a text-based PDF.')
        if not text.strip():
            raise ValueError('No readable text found in this PDF (it may be a scanned image). Paste the text instead.')
        return text
    if ext == '.docx':
        try:
            from docx import Document
            d = Document(io.BytesIO(data))
            parts = [p.text for p in d.paragraphs]
            for t in d.tables:
                for row in t.rows:
                    parts.extend(cell.text for cell in row.cells)
            return '\n'.join(parts)
        except Exception:
            raise ValueError('DOCX reading failed. Please check the file.')
    raise ValueError('Supported formats: PDF, DOCX and TXT.')


# --------------------------------------------------------------------------- AI helpers
def friendly_error(e):
    m = str(e).lower()
    if any(k in m for k in ('api key', 'api_key', 'permission_denied', '401', '403', 'unauthenticated')):
        return 'Gemini rejected the API key. Check GEMINI_API_KEY in your .env file.'
    if any(k in m for k in ('429', 'quota', 'resource_exhausted', 'rate limit')):
        return 'Gemini quota / rate limit reached. Please wait a minute and try again.'
    if any(k in m for k in ('timeout', 'timed out', 'deadline')):
        return 'Gemini took too long to respond.'
    if any(k in m for k in ('404', 'not_found', 'not found')):
        return 'The configured Gemini model was not found. Check GEMINI_MODEL in .env.'
    if any(k in m for k in ('connect', 'network', 'resolve', 'getaddrinfo')):
        return 'Could not reach Gemini (network problem).'
    return 'Gemini request failed.'


def generate(contents, config=None):
    """Call Gemini, falling back to other models when one is missing or rate-limited."""
    if not client:
        raise RuntimeError('Gemini client not configured')
    order = [_state['model']] + [m for m in MODELS if m != _state['model']]
    order = [m for m in order if m not in _bad_models] or MODELS
    last = None
    for m in order:
        try:
            res = client.models.generate_content(model=m, contents=contents, config=config)
            _state['model'] = m
            return res
        except Exception as e:
            last = e
            msg = str(e).lower()
            print(f'[gemini] {m} failed: {str(e)[:300]}')
            if any(k in msg for k in ('404', 'not_found', 'not found', 'not supported', 'unsupported')):
                _bad_models.add(m)
                continue
            if any(k in msg for k in ('429', 'resource_exhausted', 'quota', 'overloaded', '503', 'unavailable')):
                continue
            raise
    raise last


def parse_json(text):
    text = (text or '').strip()
    text = re.sub(r'^```(?:json)?\s*|\s*```$', '', text, flags=re.I).strip()
    try:
        return json.loads(text)
    except Exception:
        m = re.search(r'[\[{].*[\]}]', text, re.S)
        if m:
            return json.loads(m.group(0))
        raise


def ai_json(prompt):
    """Returns (data, warning)."""
    if not client:
        return None, None
    try:
        from google.genai import types
        res = generate(prompt, types.GenerateContentConfig(response_mime_type='application/json', temperature=0.25))
        return parse_json(res.text), None
    except Exception as e:
        print('AI analysis error:', e)
        return None, friendly_error(e)


def embedding(text):
    if not client:
        return None
    try:
        return client.models.embed_content(model=EMBED_MODEL, contents=text[:8000]).embeddings[0].values
    except Exception as e:
        print('Embedding error:', str(e)[:300])
        return None


def cosine(a, b):
    if not a or not b:
        return 0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0


# --------------------------------------------------------------------------- roadmap helpers
def norm_priority(p, i=0):
    p = str(p or '').strip().lower()
    if p.startswith('h'):
        return 'high'
    if p.startswith('l'):
        return 'low'
    if p.startswith('m'):
        return 'medium'
    if p.startswith('p') or p.startswith('b'):
        return 'build'
    return 'high' if i == 0 else 'medium'


def norm_weeks(items):
    if isinstance(items, dict):
        items = items.get('weeks') or items.get('roadmap') or items.get('plan') or []
    out = []
    for i, w in enumerate(items if isinstance(items, list) else []):
        if not isinstance(w, dict):
            continue
        tasks = w.get('tasks') or []
        if isinstance(tasks, str):
            tasks = [tasks]
        hours = w.get('hours')
        out.append({
            'week': i + 1,
            'title': str(w.get('title') or w.get('focus') or f'Week {i + 1}')[:120],
            'description': str(w.get('description') or '')[:300],
            'tasks': [str(t)[:180] for t in tasks if t][:6],
            'hours': str(hours) if hours not in (None, '') else '4–6',
            'priority': norm_priority(w.get('priority'), i),
        })
    return out[:8]


FIELD_CATALOGS = {
    'electronics': {
        'terms': r'electronic|electronics|electrical|embedded|pcb|circuit|microcontroller|instrumentation|power engineer|hardware engineer|telecommunication',
        'skills': ['Circuit Design', 'Circuit Simulation', 'Analog Electronics', 'Digital Electronics', 'Power Electronics', 'PCB Design', 'Microcontrollers', 'Embedded Systems', 'Embedded C', 'C++', 'MATLAB', 'Simulink', 'Control Systems', 'Signal Processing', 'Instrumentation', 'Sensors', 'Power Systems', 'Electrical Machines', 'Communication Systems', 'RF Engineering', 'VLSI', 'Hardware Debugging', 'Electrical Testing', 'Proteus', 'Altium Designer', 'KiCad', 'Oscilloscope', 'Multimeter', 'Soldering']
    },
    'frontend': {
        'terms': r'frontend|front-end|web developer|web development|ui developer|react developer',
        'skills': ['HTML', 'CSS', 'JavaScript', 'TypeScript', 'Responsive Design', 'Accessibility', 'React', 'Next.js', 'Git', 'API Integration', 'Testing', 'Tailwind CSS']
    },
    'backend': {
        'terms': r'backend|back-end|server[- ]side|api developer',
        'skills': ['Python', 'Java', 'Node.js', 'Express', 'Flask', 'Django', 'REST API', 'SQL', 'MongoDB', 'Docker', 'AWS', 'Testing']
    },
    'data': {
        'terms': r'data analyst|data scientist|data engineer|analytics',
        'skills': ['Python', 'SQL', 'Data Analysis', 'Machine Learning', 'Statistics', 'Excel', 'Power BI', 'Tableau']
    },
    'ai': {
        'terms': r'generative ai|machine learning|artificial intelligence|llm|ai engineer',
        'skills': ['Python', 'Machine Learning', 'LLM', 'Prompt Engineering', 'Embeddings', 'RAG', 'Vector Database', 'API Integration']
    }
}

def detect_field(role, jd):
    text = f'{role or ""} {jd or ""}'.lower()
    for field, config in FIELD_CATALOGS.items():
        if re.search(config['terms'], text, re.I):
            return field
    return 'general'


def field_skills(field):
    return FIELD_CATALOGS.get(field, {}).get('skills', [])


def local_roadmap(skills, weeks=4, role='', field=''):
    skills = [s for s in dict.fromkeys(str(s) for s in skills if s)]
    field = field or detect_field(role, '')
    if not skills:
        skills = field_skills(field)[:max(4, weeks)]
    if not skills and field == 'general':
        base = [
            ('Understand the role', 'Map the core responsibilities and required knowledge for this role.', ['Break down the job description into core responsibilities', 'Research the tools and standards used in this field', 'Identify your strongest and weakest areas']),
            ('Build core knowledge', 'Strengthen the foundational knowledge needed for the target role.', ['Study the most important fundamentals', 'Create concise notes and practice questions', 'Complete a small practical exercise']),
            ('Apply your learning', 'Turn theory into evidence you can demonstrate.', ['Complete a role-relevant practical project', 'Document your process and decisions', 'Ask for feedback and improve the work']),
            ('Prepare for opportunities', 'Present your skills clearly and prepare for interviews.', ['Tailor your resume to this role', 'Prepare examples from your work', 'Practice role-specific interview questions']),
        ]
        return [{'week': i + 1, 'title': t, 'description': d, 'tasks': tasks, 'hours': '4–6', 'priority': 'high' if i == 0 else 'medium'} for i, (t, d, tasks) in enumerate(base[:weeks])]
    out = []
    field_projects = {
        'electronics': ('Electronics lab project', 'Apply the concepts using a circuit or hardware prototype.', ['Choose a small circuit or embedded-system problem', 'Simulate the design in a suitable tool such as Proteus, LTspice or MATLAB when relevant', 'Build or test the circuit safely and record measurements', 'Document the schematic, components, results and limitations']),
        'frontend': ('Build a responsive web project', 'Apply the web skills in a polished, accessible interface.', ['Plan a small responsive interface', 'Implement semantic HTML, CSS and JavaScript', 'Test keyboard access and different screen sizes', 'Deploy the project and document it']),
        'backend': ('Build a small API project', 'Apply backend concepts in a working service.', ['Design a small REST API', 'Implement validation and error handling', 'Add tests and persistence where relevant', 'Document endpoints and run instructions']),
        'data': ('Complete a data analysis project', 'Turn a real dataset into clear, useful findings.', ['Choose and clean a relevant dataset', 'Explore trends and validate assumptions', 'Create useful charts or a dashboard', 'Write a short findings report']),
        'ai': ('Build an AI application', 'Apply AI concepts in a small, testable application.', ['Choose one narrow user problem', 'Build a small model/API workflow', 'Evaluate outputs and handle failures', 'Document limitations and example results'])
    }
    for i, skill in enumerate(skills[:max(1, weeks - 1)]):
        out.append({'week': i + 1, 'title': f'{skill} foundations', 'description': f'Build practical, demonstrable knowledge of {skill} for {role or field + " roles"}.',
                    'tasks': [f'Learn the core principles of {skill}', f'Study common applications of {skill} in {role or field + " work"}', f'Complete a hands-on exercise using {skill}', f'Record what you learned and the result'],
                    'hours': '5–7', 'priority': 'high' if i == 0 else 'medium'})
    if len(out) < weeks:
        t, d, tasks = field_projects.get(field, ('Role-relevant practical project', 'Apply the knowledge you have developed in a practical task.', ['Choose a realistic problem from the target role', 'Plan and complete a small solution', 'Test the result and document your decisions', 'Prepare a short explanation of your work']))
        out.append({'week': len(out) + 1, 'title': t, 'description': d, 'tasks': tasks, 'hours': '8–10', 'priority': 'build'})
    return out[:weeks]


# --------------------------------------------------------------------------- analysis
def build_ai_prompt(resume, jd, role):
    return ('Return valid JSON only. Analyze this resume against this job description. JSON keys: summary (string), strengths (array of strings), '
            'gaps (array of objects {skill,priority (High|Medium|Low),reason}), suggestions (array of strings), '
            'interview_questions (array of objects {question,answer_hint}), '
            'roadmap (array of 4 objects {week,title,description,tasks(array of strings),hours(string like "5-7"),priority}). '
            'Only include skills, gaps and roadmap topics that are directly relevant to the target job field and supported by the job description. Never introduce frontend/web skills for electronics or electrical roles (or unrelated skills for any other field). Do not add skills absent from the job description. Be specific and truthful; do not invent candidate experience.\nROLE: ' + (role or 'Not specified') +
            '\nRESUME:\n' + resume[:12000] + '\nJOB:\n' + jd[:12000])


def analyze(resume, jd, role, company, save=True):
    rskills = found_skills(resume)
    jskills = found_skills(jd)
    field = detect_field(role, jd)
    if field != 'general':
        allowed = set(field_skills(field))
        rskills = [s for s in rskills if s in allowed]
        jskills = [s for s in jskills if s in allowed]
    rset = set(rskills)
    matched = [s for s in jskills if s in rset]
    gaps = [s for s in jskills if s not in rset]
    extra = [s for s in rskills if s not in set(jskills)]
    skill_score = round(100 * len(matched) / max(1, len(jskills)))

    emb_score, ai, warning = None, None, None
    if client:
        with ThreadPoolExecutor(max_workers=3) as ex:
            f_r, f_j = ex.submit(embedding, resume), ex.submit(embedding, jd)
            f_ai = ex.submit(ai_json, build_ai_prompt(resume, jd, role))
            er, ej = f_r.result(), f_j.result()
            ai, warning = f_ai.result()
        if er and ej:
            emb_score = max(0, min(100, round(cosine(er, ej) * 100)))
    if not isinstance(ai, dict):
        ai = None
    score = round(skill_score * .72 + (emb_score if emb_score is not None else skill_score) * .28)
    if not jskills:
        score = emb_score if emb_score is not None else 0

    details = {}
    if ai:
        for g in ai.get('gaps') or []:
            if isinstance(g, dict) and g.get('skill'):
                sk = str(g['skill']).strip()
                details[sk.lower()] = {'priority': norm_priority(g.get('priority')), 'reason': str(g.get('reason') or '')}
                # AI may add explanations for extracted gaps, but cannot invent requirements.
        summary = str(ai.get('summary') or '').strip()
    else:
        summary = ''
    if not summary:
        summary = (f'Your resume lists {len(matched)} of the {len(jskills)} detected job skills. ' if jskills else 'No common skill keywords were detected in the job description. ') + \
                  ('Strong alignment in core skills; focus on the gaps below.' if skill_score >= 65 else 'Prioritize the missing requirements and tailor your resume to relevant projects.')

    gap_details = []
    for i, s in enumerate(gaps):
        d = details.get(s.lower(), {})
        gap_details.append({'skill': s, 'priority': d.get('priority') or ('high' if i < 2 else 'medium'),
                            'reason': d.get('reason') or f'{s} is requested in the job description but was not detected in your resume. Build evidence through a small project before claiming it.'})

    # Keep free-form AI text field-specific too. Structured skill lists are already
    # constrained above; this prevents unrelated skills leaking through prose.
    field_skill_names = {s.lower() for catalog in FIELD_CATALOGS.values() for s in catalog['skills']}
    other_field_skills = field_skill_names - set(s.lower() for s in field_skills(field)) if field != 'general' else set()
    def field_relevant(text):
        value = str(text or '').strip()
        return value and not any(re.search(r'(?<![\w])' + re.escape(skill) + r'(?![\w])', value, re.I) for skill in other_field_skills)

    if not field_relevant(summary):
        summary = ''
        summary = (f'Your resume lists {len(matched)} of the {len(jskills)} detected job skills. ' if jskills else 'No common skill keywords were detected in the job description. ') + \
                  ('Strong alignment in core skills; focus on the gaps below.' if skill_score >= 65 else 'Prioritize the missing requirements and tailor your resume to relevant projects.')
    strengths = [str(x) for x in (ai or {}).get('strengths') or [] if field_relevant(x)] or [f'{s} appears in both your resume and the job description' for s in matched[:5]]
    suggestions = [str(x) for x in (ai or {}).get('suggestions') or [] if field_relevant(x)] or [
        'Tailor your project descriptions to the responsibilities in this job posting.',
        'Add measurable outcomes to projects where truthful.',
        'Use relevant keywords naturally when they accurately describe your experience.']
    questions = []
    for q in (ai or {}).get('interview_questions') or []:
        if isinstance(q, dict) and q.get('question') and field_relevant(q.get('question')) and (not q.get('answer_hint') or field_relevant(q.get('answer_hint'))):
            questions.append({'question': str(q['question']), 'answer_hint': str(q.get('answer_hint') or '')})
        elif isinstance(q, str) and field_relevant(q):
            questions.append({'question': q.strip(), 'answer_hint': ''})
    if not questions:
        questions = [{'question': f'How have you used {s} in a project?', 'answer_hint': 'Describe the context, your role, approach and outcome.'} for s in (matched[:3] or jskills[:3])]
        questions += [{'question': f'How would you start learning {s} for this role?', 'answer_hint': 'Show a realistic plan and mention what you would build.'} for s in gaps[:2]]
    roadmap = local_roadmap(gaps, role=role, field=field)

    payload = {
        'role': role or 'Target Role', 'company': company or 'Company not specified', 'score': score, 'skill_score': skill_score,
        'semantic_score': emb_score, 'resume_skills': rskills, 'job_skills': jskills, 'matched': matched, 'gaps': gaps, 'gap_details': gap_details,
        'extra': extra, 'summary': summary, 'strengths': strengths, 'suggestions': suggestions, 'interview_questions': questions,
        'roadmap': roadmap, 'field': field, 'ai_enabled': bool(ai), 'ai_warning': warning, 'created': datetime.now().strftime('%Y-%m-%d %H:%M'), 'id': None,
    }
    if save:
        with get_db() as c:
            cur = c.execute('INSERT INTO analyses(role,company,score,payload,created) VALUES(?,?,?,?,?)',
                            (payload['role'], payload['company'], score, json.dumps(payload), payload['created']))
            payload['id'] = cur.lastrowid
            c.execute('UPDATE analyses SET payload=? WHERE id=?', (json.dumps(payload), payload['id']))
    return payload


# --------------------------------------------------------------------------- errors / assets
@app.context_processor
def asset_version():
    def v(path):
        try:
            return int((BASE_DIR / 'static' / path).stat().st_mtime)
        except OSError:
            return 0
    return {'asset_v': v}


@app.errorhandler(Exception)
def handle_error(e):
    wants_json = request.path.startswith('/api/')
    if isinstance(e, HTTPException):
        if wants_json:
            msg = 'File is too large (max 12 MB).' if e.code == 413 else (e.description if e.code != 404 else 'Not found')
            return jsonify(error=msg), e.code
        return e
    traceback.print_exc()
    if wants_json:
        return jsonify(error='Something went wrong on the server. Check the terminal for details.'), 500
    return 'Internal server error', 500


@app.after_request
def no_cache_api(resp):
    if request.path.startswith('/api/'):
        resp.headers['Cache-Control'] = 'no-store'
    return resp


# --------------------------------------------------------------------------- routes: pages / status
@app.route('/')
def home():
    return render_template('index.html')


@app.route('/api/status')
def status():
    return jsonify({'api_configured': bool(client), 'model': _state['model'], 'embedding_model': EMBED_MODEL})


@app.route('/api/health')
def health():
    return jsonify(ok=True)


# --------------------------------------------------------------------------- routes: analyses
@app.route('/api/analyze', methods=['POST'])
def api_analyze():
    try:
        resume = request.form.get('resume_text', '').strip()
        jd = request.form.get('job_text', '').strip()
        rf, jf = request.files.get('resume_file'), request.files.get('job_file')
        if rf and rf.filename:
            resume = text_from_file(rf).strip() or resume
        if jf and jf.filename:
            jd = text_from_file(jf).strip() or jd
        if not resume or not jd:
            return jsonify(error='Please provide both resume and job description.'), 400
        if len(resume) > 30000 or len(jd) > 30000:
            return jsonify(error='Text is too long. Please keep each input under 30,000 characters.'), 400
        save = request.form.get('save', '1') != '0'
        return jsonify(analyze(resume, jd, request.form.get('role', '').strip(), request.form.get('company', '').strip(), save))
    except ValueError as e:
        return jsonify(error=str(e)), 400


@app.route('/api/history')
def history():
    with get_db() as c:
        rows = c.execute('SELECT id,role,company,score,created,payload FROM analyses ORDER BY id DESC LIMIT 100').fetchall()
    return jsonify([{'id': r['id'], 'role': r['role'], 'company': r['company'], 'score': r['score'], 'created': r['created'], 'payload': json.loads(r['payload'])} for r in rows])


@app.route('/api/history/<int:aid>')
def history_detail(aid):
    with get_db() as c:
        r = c.execute('SELECT payload FROM analyses WHERE id=?', (aid,)).fetchone()
    return jsonify(json.loads(r['payload'])) if r else (jsonify(error='Not found'), 404)


@app.route('/api/history/<int:aid>', methods=['DELETE'])
def delete_analysis(aid):
    with get_db() as c:
        c.execute('DELETE FROM analyses WHERE id=?', (aid,))
    return jsonify(ok=True)


@app.route('/api/history', methods=['DELETE'])
def clear_history():
    with get_db() as c:
        c.execute('DELETE FROM analyses')
    return jsonify(ok=True)


# --------------------------------------------------------------------------- chat
def latest_analysis():
    with get_db() as c:
        r = c.execute('SELECT payload FROM analyses ORDER BY id DESC LIMIT 1').fetchone()
    return json.loads(r['payload']) if r else None


def analysis_by_id(aid):
    try:
        with get_db() as c:
            r = c.execute('SELECT payload FROM analyses WHERE id=?', (int(aid),)).fetchone()
        return json.loads(r['payload']) if r else None
    except (TypeError, ValueError):
        return None


def compact_context(a):
    if not a:
        return {}
    keys = ['role', 'field', 'company', 'score', 'matched', 'gaps', 'extra', 'summary', 'strengths', 'suggestions']
    return {k: a.get(k) for k in keys if k in a}


def local_reply(message, a):
    m = message.lower()
    if not a:
        return ('I do not have a job analysis to work from yet. Run **New Analysis** with your resume and a job description and I can point out your exact skill gaps, '
                'build a learning plan and prepare interview questions. In the meantime: tailor your resume to each job, show real projects, and quantify results where you can.')
    role = a.get('role', 'this role')
    gaps, matched = a.get('gaps') or [], a.get('matched') or []
    if re.search(r'interview|question', m):
        qs = [q.get('question') if isinstance(q, dict) else q for q in (a.get('interview_questions') or [])][:5]
        return f'Interview questions to practise for {role}:\n' + '\n'.join(f'{i + 1}. {q}' for i, q in enumerate(qs)) if qs else 'Run a fresh analysis to generate interview questions.'
    if re.search(r'plan|roadmap|learn|week|day|study', m):
        wk = local_roadmap(gaps, role=role, field=a.get('field'))
        return f'A simple plan for {role}:\n' + '\n'.join(f"Week {w['week']} – {w['title']}: " + '; '.join(w['tasks'][:2]) for w in wk)
    if re.search(r'missing|gap|lack|weak|skill', m):
        if not gaps:
            return f'Good news – no skill-keyword gaps were detected for {role}. Focus on showing measurable results in your projects.'
        return f'Skills missing for {role}: ' + ', '.join(gaps) + '.\nStart with the first two and build a small project for each before listing them on your resume.'
    if re.search(r'resume|cv|tailor|improve|rewrite', m):
        return 'To tailor your resume:\n' + '\n'.join('• ' + s for s in (a.get('suggestions') or [])[:5])
    return (f"Your match for {role} is {a.get('score', 0)}%. You matched {len(matched)} skill(s)" + (f" ({', '.join(matched[:6])})" if matched else '') +
            f" and have {len(gaps)} gap(s)" + (f" ({', '.join(gaps[:6])})" if gaps else '') + '. Ask me about missing skills, a learning plan, resume tips or interview questions.')


CHAT_TOOLS = [{'function_declarations': [
    {'name': 'calculate_skill_match', 'description': 'Calculate percentage of job skills matched to resume skills',
     'parameters': {'type': 'OBJECT', 'properties': {'matched_skills': {'type': 'ARRAY', 'items': {'type': 'STRING'}}, 'required_skills': {'type': 'ARRAY', 'items': {'type': 'STRING'}}}, 'required': ['matched_skills', 'required_skills']}},
    {'name': 'make_learning_plan', 'description': 'Create a structured learning plan for missing skills',
     'parameters': {'type': 'OBJECT', 'properties': {'skills': {'type': 'ARRAY', 'items': {'type': 'STRING'}}, 'weeks': {'type': 'INTEGER'}}, 'required': ['skills', 'weeks']}}]}]


def ai_reply(message, history, analysis):
    from google.genai import types
    transcript = '\n'.join(('User: ' if h['role'] == 'user' else 'Assistant: ') + h['content'][:1500] for h in history)
    prompt = ('You are CareerMatch AI, a friendly career assistant. Help with resume/job matching, skill gaps, interview prep and learning plans. '
              'Use the analysis context when relevant. Respect the detected target field and never suggest unrelated skills (for example HTML/CSS for electronics roles). Never invent resume facts. Keep answers practical and reasonably concise; use short lists when helpful.\n'
              f'ANALYSIS CONTEXT: {json.dumps(compact_context(analysis))[:8000]}\n'
              f'CONVERSATION SO FAR:\n{transcript}\nUser: {message}\nAssistant:')
    response = generate(prompt, types.GenerateContentConfig(tools=CHAT_TOOLS, temperature=.4))
    parts = (response.candidates[0].content.parts if response.candidates else None) or []
    call = next((p.function_call for p in parts if getattr(p, 'function_call', None)), None)
    if call:
        args = dict(call.args or {})
        if call.name == 'calculate_skill_match':
            mm, req = args.get('matched_skills', []), args.get('required_skills', [])
            result = f'Match calculator result: {round(len(mm) / max(1, len(req)) * 100)}% ({len(mm)}/{len(req)} skills).'
        else:
            skills = list(args.get('skills', []))
            weeks = max(1, min(12, int(args.get('weeks', 4) or 4)))
            result = 'Learning plan: ' + json.dumps([{'week': i + 1, 'focus': skills[i % len(skills)] if skills else 'Fundamentals'} for i in range(weeks)])
        second = generate(prompt + '\nTool result: ' + result + '\nNow answer the user using this result.')
        return (second.text or result), call.name
    return (response.text or 'I could not generate a response.'), None


@app.route('/api/chat', methods=['POST'])
def chat():
    data = request.get_json(silent=True) or {}
    message = str(data.get('message', '')).strip()
    if not message:
        return jsonify(error='Message is empty'), 400
    if len(message) > 4000:
        return jsonify(error='Message is too long (max 4000 characters).'), 400
    chat_id = data.get('chat_id')
    with get_db() as c:
        exists = c.execute('SELECT id FROM chats WHERE id=?', (chat_id,)).fetchone() if chat_id else None
        if exists:
            history = [dict(r) for r in c.execute('SELECT role,content FROM chat_messages WHERE chat_id=? ORDER BY id DESC LIMIT 10', (chat_id,)).fetchall()][::-1]
        else:
            title = re.sub(r'\s+', ' ', message)[:48] + ('…' if len(message) > 48 else '')
            chat_id = c.execute('INSERT INTO chats(title,created,updated) VALUES(?,?,?)', (title, now(), now())).lastrowid
            history = []
        c.execute('INSERT INTO chat_messages(chat_id,role,content,created) VALUES(?,?,?,?)', (chat_id, 'user', message, now()))
        c.execute('UPDATE chats SET updated=? WHERE id=?', (now(), chat_id))

    analysis = analysis_by_id(data.get('analysis_id')) if data.get('analysis_id') else None
    analysis = analysis or (data.get('analysis') if isinstance(data.get('analysis'), dict) and data.get('analysis') else None) or latest_analysis()

    reply, tool, warning = None, None, None
    if client:
        try:
            reply, tool = ai_reply(message, history, analysis)
        except Exception as e:
            print('chat error:', e)
            warning = friendly_error(e)
    if reply is None:
        reply = local_reply(message, analysis)
        if not client:
            reply += '\n\n(Offline mode – add GEMINI_API_KEY to .env for full AI answers.)'
        elif warning:
            reply += f'\n\n({warning} Showing an offline answer instead.)'

    with get_db() as c:
        c.execute('INSERT INTO chat_messages(chat_id,role,content,tool,created) VALUES(?,?,?,?,?)', (chat_id, 'assistant', reply, tool, now()))
        c.execute('UPDATE chats SET updated=? WHERE id=?', (now(), chat_id))
        title = c.execute('SELECT title FROM chats WHERE id=?', (chat_id,)).fetchone()['title']
    return jsonify(reply=reply, tool_used=tool, chat_id=chat_id, title=title, warning=warning)


@app.route('/api/chats')
def list_chats():
    with get_db() as c:
        rows = c.execute('''SELECT c.id,c.title,c.created,c.updated,
                            (SELECT COUNT(*) FROM chat_messages m WHERE m.chat_id=c.id) AS count,
                            (SELECT content FROM chat_messages m WHERE m.chat_id=c.id ORDER BY m.id DESC LIMIT 1) AS preview
                            FROM chats c ORDER BY c.updated DESC, c.id DESC LIMIT 200''').fetchall()
    return jsonify([{**dict(r), 'preview': (r['preview'] or '')[:90]} for r in rows])


@app.route('/api/chats/<int:cid>')
def get_chat(cid):
    with get_db() as c:
        ch = c.execute('SELECT id,title,created,updated FROM chats WHERE id=?', (cid,)).fetchone()
        if not ch:
            return jsonify(error='Chat not found'), 404
        msgs = [dict(r) for r in c.execute('SELECT id,role,content,tool,created FROM chat_messages WHERE chat_id=? ORDER BY id', (cid,)).fetchall()]
    return jsonify({**dict(ch), 'messages': msgs})


@app.route('/api/chats/<int:cid>', methods=['PATCH'])
def rename_chat(cid):
    title = re.sub(r'\s+', ' ', str((request.get_json(silent=True) or {}).get('title', ''))).strip()[:80]
    if not title:
        return jsonify(error='Title cannot be empty'), 400
    with get_db() as c:
        c.execute('UPDATE chats SET title=? WHERE id=?', (title, cid))
    return jsonify(ok=True, title=title)


@app.route('/api/chats/<int:cid>', methods=['DELETE'])
def delete_chat(cid):
    with get_db() as c:
        c.execute('DELETE FROM chat_messages WHERE chat_id=?', (cid,))
        c.execute('DELETE FROM chats WHERE id=?', (cid,))
    return jsonify(ok=True)


@app.route('/api/chats', methods=['DELETE'])
def delete_all_chats():
    with get_db() as c:
        c.execute('DELETE FROM chat_messages')
        c.execute('DELETE FROM chats')
    return jsonify(ok=True)


# --------------------------------------------------------------------------- roadmap
@app.route('/api/roadmap', methods=['POST'])
def roadmap():
    d = request.get_json(silent=True) or {}
    raw = d.get('gaps') or d.get('skills') or []
    if isinstance(raw, str):
        raw = [s for s in re.split(r'[,\n;]', raw)]
    gaps = [str(g.get('skill') if isinstance(g, dict) else g).strip() for g in raw]
    gaps = [g for g in dict.fromkeys(gaps) if g][:12]
    try:
        weeks = max(2, min(8, int(d.get('weeks') or 4)))
    except (TypeError, ValueError):
        weeks = 4
    role = str(d.get('role') or '').strip()
    requested_field = str(d.get('field') or '').strip().lower()
    field = requested_field if requested_field in FIELD_CATALOGS else detect_field(role, str(d.get('job_description') or ''))
    if field != 'general':
        allowed = set(field_skills(field))
        gaps = [g for g in gaps if g in allowed]
    # Use deterministic field-aware roadmaps so unrelated AI-generated topics cannot leak in.
    out = local_roadmap(gaps, weeks, role=role, field=field)
    return jsonify(weeks=out, source='field-aware', warning=None, field=field)


init_db()

if __name__ == '__main__':
    debug = os.getenv('FLASK_DEBUG', '0') == '1'
    print(f"CareerMatch AI running → http://127.0.0.1:{os.getenv('PORT', 5000)}  (Gemini: {'ON · ' + MODEL if client else 'OFF – local mode'})")
    # use_reloader=False: the auto-reloader restarts the server in the middle of AI requests, which shows up in the browser as "Failed to fetch".
    app.run(host=os.getenv('HOST', '127.0.0.1'), port=int(os.getenv('PORT', 5000)), debug=debug, use_reloader=False, threaded=True)
