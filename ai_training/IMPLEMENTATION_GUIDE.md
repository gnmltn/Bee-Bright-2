# Bee Bright AI Implementation Guide

Step-by-step guide for chatbot, AI recommendations, Jupyter training, CSV export, and Ollama (LLM).

---

## 0. Ollama (Local LLM) – Optional

Use Ollama for a real AI chatbot instead of rule-based. Free, runs on your PC.

### Step 1: Install Ollama

1. Download: [ollama.com/download](https://ollama.com/download)
2. Install for Windows/Mac/Linux
3. Open a terminal and run a model:
   ```bash
   ollama run llama2
   ```
   (First run downloads the model. Other options: `mistral`, `llama3`, `phi`)

### Step 2: Enable Ollama in Bee Bright

1. Open `backend/.env`
2. Add:
   ```env
   OLLAMA_ENABLED=true
   OLLAMA_BASE_URL=http://localhost:11434
   OLLAMA_MODEL=llama2
   ```
3. Restart the backend: `cd backend && npm run dev`

### Step 3: Test

- Open the home page and click the chat bubble
- Ask a question – replies will come from Ollama (takes 2–5 seconds)
- If Ollama is not running or unreachable, the chatbot falls back to rule-based replies

### Optional env vars

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_ENABLED` | `false` | Set to `true` to use Ollama |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `llama2` | Model name (llama2, mistral, llama3, etc.) |

---

## 1. Landing Page Chatbot (New User Guide)

### Where it is
- **Component**: `frontend/src/components/landing/LandingChatbot.tsx`
- **Page**: `frontend/src/pages/Index.tsx` (home page)
- **API**: `POST /api/ai/chat/public` (no auth required)

### What it does
- Floating chat bubble on bottom-right of home page
- Guides new users: enrollment, programs, pricing, schedule
- Suggested questions: "How do I enroll?", "What programs do you offer?", etc.

### How to use
1. Open the home page (`/`)
2. Click the chat bubble (bottom-right)
3. Ask questions or use suggested buttons
4. Chat uses `PUBLIC_CHAT_RULES` in `backend/controllers/aiController.js`

---

## 2. Student & Tutor AI Tab (Chat + Recommendations)

### Where it is
- **Component**: `frontend/src/components/ai/AITab.tsx`
- **Student**: `StudentDashboard.tsx` → Progress tab → AI Assistant
- **Tutor**: `TutorDashboard.tsx` → AI tab
- **API**: `GET /api/ai/recommendations`, `POST /api/ai/chat`

### Student AI Recommendations
**Purpose**: When a student gets a low grade (&lt; 75%) in a subject, the AI recommends materials to help them improve and get higher grades.

**How it works**:
1. Tutor records grades with `programCategory` + `subjectItem` (e.g. Academic Tutorial, Mathematics)
2. Tutor uploads materials (slides, practice sheets, videos) and sets `programCategory` + `subjectItem`, assigns students
3. API finds subjects where the student scored &lt; 75%
4. Student sees **"Materials for subjects you need extra support in"** — clickable links to tutor materials

**How to use (for students)**:
1. Go to **Student Dashboard** → **Progress** tab
2. Scroll to the **Recommendations** section
3. If you have low grades, you'll see materials grouped by subject
4. Click links to open materials and study to improve your grades

### Tutor AI Recommendations
**Purpose**: Shows tutors which students have low grades (&lt; 75%) so they know who to prioritize in teaching. Also provides resource links per subject.

**How it works**:
1. Tutor records grades for students they teach
2. API finds grades &lt; 75% recorded by this tutor
3. Tutor sees **"Students needing extra support (below 75%)"** — list of student name, subject, and percentage
4. Tutor can prioritize teaching these topics to help students improve

**How to use (for tutors)**:
1. Go to **Tutor Dashboard** → **AI** tab
2. Check **"Students needing extra support"** — sorted by lowest grade first
3. Focus on those subjects/topics when teaching
4. Share materials (slides, practice sheets) with struggling students
5. Use the resource links (Khan Academy, etc.) per subject

### Make it work
1. **Student**: Ensure grades have `programCategory` and `subjectItem` matching `PROGRAM_CATEGORIES` in `frontend/src/constants/programs.ts`
2. **Tutor**: Upload materials with `programCategory` and `subjectItem` set, and assign the student
3. **Chat**: Uses `CHAT_RULES` in `backend/controllers/aiController.js`

---

## 3. Jupyter Notebook (AI Training)

### Where to put
- **Notebook**: `beebright-ui-showcase/ai_training/bee_bright_ai_training.ipynb`
- **Data**: `beebright-ui-showcase/ai_training/data/`
- **Output**: `beebright-ui-showcase/ai_training/output/`

### Step 1: Install
```bash
cd beebright-ui-showcase/ai_training
pip install pandas scikit-learn
```

### Step 2: Prepare CSV files
Put (or export) CSVs in `ai_training/data/`:
- `grades_sample.csv` – studentId, tutorId, programCategory, subjectItem, score, maxScore, period, remarks
- `materials_sample.csv` – title, description, materialType, category, programCategory, subjectItem, assignedStudentIds
- `chat_rules_sample.csv` – keywords, reply

### Step 3: Run notebook
1. Open `bee_bright_ai_training.ipynb` in Jupyter or VS Code
2. Run cells in order
3. Outputs go to `ai_training/output/`:
   - `recommendation_rules.json`
   - `chat_rules.json`
   - `grades_with_pct.csv`
   - `student_recommendations.csv`

### Step 4: (Optional) Use exported rules in backend
Copy `chat_rules.json` content into `aiController.js` `CHAT_RULES` or `PUBLIC_CHAT_RULES` if you want to load rules from file.

---

## 4. CSV Export (Training Data)

### API
- **Endpoint**: `GET /api/ai/export-training-data`
- **Auth**: Admin token required (`Authorization: Bearer <token>`)
- **Query**: `?type=grades` | `?type=materials` | `?type=all` (default) | `?type=csv`

### How to use
1. Log in as admin
2. Copy your token from browser devtools (Application → Local Storage → token)
3. Call API:
   ```bash
   curl -H "Authorization: Bearer YOUR_TOKEN" "http://localhost:5000/api/ai/export-training-data?type=csv" -o grades_export.csv
   ```
4. Or `?type=all` returns JSON: `{ grades: [...], materials: [...] }`
5. Save JSON arrays to CSV manually if needed

### CSV structure for grades
```
studentId,tutorId,programCategory,subjectItem,score,maxScore,period,remarks
```

### CSV structure for materials
```
title,description,materialType,category,programCategory,subjectItem,assignedStudentIds
```

---

## 5. File Structure Quick Reference

```
beebright-ui-showcase/
├── frontend/src/
│   ├── components/
│   │   ├── ai/AITab.tsx           # Chat + Recommendations (student/tutor)
│   │   └── landing/LandingChatbot.tsx  # Home page chatbot
│   ├── constants/
│   │   ├── programs.ts            # PROGRAM_CATEGORIES for grades
│   │   └── programRecommendationLinks.ts  # Tutor resource links
│   ├── pages/
│   │   └── Index.tsx              # Uses LandingChatbot
│   └── services/api.ts            # aiService.chat, chatPublic, getRecommendations
├── backend/
│   ├── controllers/aiController.js   # getRecommendations, chat, chatPublic, exportTrainingData
│   └── routes/aiRoutes.js
└── ai_training/
    ├── bee_bright_ai_training.ipynb
    ├── data/
    │   ├── grades_sample.csv
    │   ├── materials_sample.csv
    │   └── chat_rules_sample.csv
    ├── output/                     # Created when notebook runs
    └── IMPLEMENTATION_GUIDE.md     # This file
```

---

## 6. Troubleshooting

### "No recommended materials" for student
1. Tutor must record grades with `programCategory` and `subjectItem`
2. Tutor must upload materials with matching `programCategory` and `subjectItem`
3. Materials must be assigned to the student
4. Grades below 75% trigger recommendations

### Chat not responding
1. Check backend is running (`cd backend && npm run dev`)
2. Check `VITE_API_URL` in frontend `.env` (e.g. `http://localhost:5000/api`)
3. For landing chatbot: no auth needed; ensure `/api/ai/chat/public` is reachable

### Ollama not working
1. Ensure Ollama is installed and a model is running: `ollama run llama2`
2. Check `OLLAMA_ENABLED=true` in `backend/.env`
3. Ensure Ollama is on `http://localhost:11434` (or set `OLLAMA_BASE_URL`)
4. If Ollama fails, the chatbot falls back to rule-based replies

### Jupyter notebook errors
1. Ensure `data/` folder exists with CSV files
2. Run `pip install pandas` if ImportError
3. Adjust `DATA_DIR` path in notebook if needed
