# CareerMatch AI — Resume & Job Match Assistant

A Flask-based career intelligence app that compares a resume with a job description, identifies matching and missing skills, estimates relevance, suggests improvements, creates a learning roadmap, and provides an AI career chat assistant.

## Features
- Resume input by paste or upload (PDF, DOCX, TXT)
- Job description paste or file upload (PDF, DOCX, TXT)
- Skill extraction and matched/missing/extra skill lists
- Match score based on skill coverage; optional semantic score using Gemini embeddings
- Gemini-generated summary, suggestions, interview prompts, and roadmap when API is configured
- Career chat endpoint with tool/function calling (skill-match calculator and learning-plan helper)
- SQLite analysis history
- Downloadable text report
- Responsive UI (desktop/tablet/mobile), mobile navigation, no horizontal overflow
- Local skill-matching mode works without API key

## Setup (Windows)
1. Extract the project ZIP.
2. Open its folder in VS Code.
3. Create a virtual environment:
   ```powershell
   python -m venv venv
   ```
4. Activate it:
   ```powershell
   .\venv\Scripts\activate
   ```
5. Install dependencies:
   ```powershell
   pip install -r requirements.txt
   ```
6. Optional but recommended: copy `.env.example` to `.env`, then add your Gemini API key:
   ```env
   GEMINI_API_KEY=your_actual_key
   GEMINI_MODEL=gemini-3.8-flash
   EMBEDDING_MODEL=gemini-embedding-001
   ```
   Create/get a key from Google AI Studio. Keep `.env` private; it is excluded by `.gitignore`.
7. Start the app:
   ```powershell
   python app.py
   ```
8. Visit **http://127.0.0.1:5000**.

## What is new in this version
- Notifications and workspace menus in the navbar (work on desktop, tablet and mobile)
- Dashboard: working period filter, match-trend selector, live trend chart and skill-coverage menu
- Career AI Chat: saved chat history (open, rename, export, delete, delete all), 3-dots menu
- Learning Roadmap: generate, mark complete, delete a week, clear all (saved in the browser)
- Saved analyses: filter/sort, delete one analysis
- Match report export: PDF (print), TXT, JSON
- The Flask auto-reloader is OFF by default (it restarted the server during AI calls and caused "Failed to fetch"). After editing Python files, restart with `python app.py`. For auto-reload during development set `FLASK_DEBUG=1`.
- Always open the app at http://127.0.0.1:5000 (not via Live Server or file://).

## Try the sample
Use the **Try sample** button, then **Analyze match**. Or copy the two files in `sample_data/` into the input fields. You can test locally without an API key; AI-generated analysis/chat and embedding-based score are available when the API key is configured.

## API routes
- `GET /api/status` — AI configuration status
- `POST /api/analyze` — multipart resume/JD inputs
- `GET /api/history` — saved analyses
- `GET /api/history/<id>` — one analysis
- `DELETE /api/history` — clear analysis history
- `POST /api/chat` — career assistant; Gemini function calling when configured
- `POST /api/roadmap` — roadmap generation

## Tech stack
Python, Flask, SQLite, Google GenAI SDK, Gemini text generation, Gemini embeddings, pypdf, python-docx, HTML/CSS/JavaScript.

## Important notes
- This is a portfolio/learning application, not an employment decision system. The score is a rough indicator and may miss skills or context.
- Resume contents are processed locally by Flask and sent to Google Gemini only if a Gemini API key is configured and AI features are invoked. Avoid uploading sensitive personal data you do not wish to process.
- Gemini model availability and quotas depend on your Google AI Studio account. You can change the model name in `.env` if needed.
- Uploaded files are processed in memory; the app stores analysis text/payloads in SQLite history. Delete saved history using Settings or the clear-history action.
- On Vercel, SQLite is placed in `/tmp` because function filesystems are read-only outside that scratch directory. `/tmp` is temporary, so saved analysis/chat history is not durable across function instances or deployments; use a hosted database for persistent production history.


## Field-specific matching improvements
- Skill extraction now includes electronics, electrical and embedded-engineering requirements (for example circuit design, PCB design, microcontrollers, MATLAB, Proteus, instrumentation and control systems).
- Analysis detects the target discipline and filters extracted skills to that discipline, so an electronics role does not inherit unrelated frontend skills from a resume.
- Learning roadmaps are built from the detected target field and its relevant skills. Electronics roadmaps focus on circuits, hardware, simulation and lab work; frontend roadmaps focus on web development.
- AI-generated gap suggestions cannot add unrelated skills to the extracted job requirements; roadmap generation uses the field-aware local plan to keep topics relevant.
- Chat and saved-record deletion endpoints explicitly remove child chat messages and refresh the UI after deletion.
