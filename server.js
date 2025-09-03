/**
 * Visa Letter API — SOP-enforced, Naira-first, Emotion-aware
 * - Fails fast if required SOP assets are missing (rules, mini_templates, samples)
 * - Uses Naira (₦) by default unless intake explicitly contains another currency symbol/code
 * - Scenario-aware (sponsored, medical, business, self-employed, refusal/re-application, tourist first-time)
 * - Same request/response contract as before: POST /generate-letter -> { letter }
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');

/* ------------------------ Load .env for local dev ------------------------ */
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  content.split(/\r?\n/).forEach((line) => {
    if (!line || line.trim().startsWith('#')) return;
    const i = line.indexOf('=');
    if (i === -1) return;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  });
}
loadEnv();

/* ------------------------ Required env ------------------------ */
if (!process.env.OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY');
  process.exit(1);
}

const MODEL_NAME = process.env.MODEL_NAME || 'gpt-5-mini';
const FALLBACK_MODEL = process.env.FALLBACK_MODEL || 'gpt-4o-mini';
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || ''; // e.g. https://visa-cover-letter-api-1.onrender.com

/* ------------------------ App & Middleware ------------------------ */
const app = express();
const PORT = process.env.PORT || 5000;

if (FRONTEND_ORIGIN) {
  const allowedOrigins = new Set([
    FRONTEND_ORIGIN,
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ]);
  app.use(
    cors({
      origin(origin, cb) {
        if (!origin) return cb(null, true); // Postman/curl
        if (allowedOrigins.has(origin)) return cb(null, true);
        return cb(new Error(`CORS blocked: ${origin}`));
      },
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    })
  );
  app.options('*', cors());
} else {
  app.use(cors());
  app.options('*', cors());
}

app.use(express.json({ limit: '1mb' }));

/* ------------------------ OpenAI Client ------------------------ */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  organization: process.env.OPENAI_ORG_ID || process.env.OPENAI_ORG || undefined,
  project: process.env.OPENAI_PROJECT_ID || process.env.OPENAI_PROJECT || undefined,
});

/* ------------------------ SOP Assets (MUST LOAD) ------------------------ */
const RULES_DIR = path.join(__dirname, 'rules');
const MINIS_DIR = path.join(__dirname, 'mini_templates');
const SAMPLES_DIR = path.join(__dirname, 'samples');

for (const d of [RULES_DIR, MINIS_DIR, SAMPLES_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const REQ_RULES = [
  'master_rules.txt',
  'structure_guide.txt',
  'quality_checklist.txt',
];
const ALT_MASTER_TEMPLATE = ['master_template.txt', 'master_templete.txt'];

function mustRead(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing required ${label}: ${path.relative(process.cwd(), filePath)}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

function clip(text = '', max = 4000) {
  const s = String(text || '');
  return s.length <= max ? s.trim() : (s.slice(0, max).trim() + '\n…');
}

function readAllTxt(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /\.(txt|md)$/i.test(f))
    .map((name) => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8') }));
}

// Load + validate at startup
let ASSETS = {
  masterRules: '',
  structureGuide: '',
  qualityChecklist: '',
  masterTemplate: '',
  minis: {},       // map filename -> text
  samples: [],     // [{name,text}]
};

(function loadAssetsStrict() {
  try {
    // rules
    for (const f of REQ_RULES) {
      ASSETS[f] = mustRead(path.join(RULES_DIR, f), 'rules file');
    }
    // master template (either spelling)
    let mt = '';
    for (const alt of ALT_MASTER_TEMPLATE) {
      const p = path.join(RULES_DIR, alt);
      if (fs.existsSync(p)) { mt = fs.readFileSync(p, 'utf8'); break; }
    }
    if (!mt) throw new Error('Missing required rules file: master_template(.txt) or master_templete(.txt)');
    ASSETS.masterTemplate = mt;

    // mini_templates (at least 1)
    const minis = readAllTxt(MINIS_DIR);
    if (!minis.length) throw new Error('mini_templates/ must contain at least one .txt/.md file');
    ASSETS.minis = minis.reduce((acc, f) => { acc[f.name] = f.text; return acc; }, {});

    // samples (at least 1)
    const samples = readAllTxt(SAMPLES_DIR);
    if (!samples.length) throw new Error('samples/ must contain at least one .txt/.md file');
    ASSETS.samples = samples;

    // Map canonical names for convenience
    ASSETS.masterRules = ASSETS['master_rules.txt'];
    ASSETS.structureGuide = ASSETS['structure_guide.txt'];
    ASSETS.qualityChecklist = ASSETS['quality_checklist.txt'];

    console.log(`✅ SOP assets loaded. rules=${REQ_RULES.length + 1} minis=${minis.length} samples=${samples.length}`);
  } catch (e) {
    console.error('❌ SOP asset loading failed:', e.message);
    process.exit(1); // enforce MUST
  }
})();

/* ------------------------ Utilities ------------------------ */
function clean(v) {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}

function containsForeignCurrencyHint(s = '') {
  // If staff typed other currency symbols/codes in intake, we won't override.
  return /USD|GBP|EUR|\$|£|€/i.test(String(s || ''));
}

function buildStyleDigest({ maxFiles = 8, perFileChars = 800, totalChars = 4000 } = {}) {
  const files = ASSETS.samples.slice(0, maxFiles);
  let out = '';
  for (let i = 0; i < files.length; i++) {
    const chunk = clip(files[i].text, perFileChars);
    const next = `\n\n### Sample ${i + 1}: ${files[i].name}\n${chunk}`;
    if ((out + next).length > totalChars) break;
    out += next;
  }
  return out.trim();
}

/* ------------------------ Prompt Builder ------------------------ */
function buildMessages(detailLines, intentFlags) {
  const styleDigest = buildStyleDigest();

  // Map minis by semantic key (file names can differ; match by contains)
  const miniLookup = (needle) => {
    const f = Object.entries(ASSETS.minis).find(([name]) => name.toLowerCase().includes(needle));
    return f ? f[1] : '';
  };
  const mini = {
    refusal: clip(miniLookup('refusal'), 1200),
    sponsor: clip(miniLookup('sponsor'), 1200),
    selfEmp: clip(miniLookup('self_employ'), 1200),
    medical: clip(miniLookup('medical'), 900),
    business: clip(miniLookup('business'), 900),
    touristFirst: clip(miniLookup('tourist') || miniLookup('first_time'), 900),
  };

  const joined = detailLines.join('\n');

  const getField = (label) => {
    const m = new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*(.+)$', 'mi').exec(joined);
    return m ? m[1].trim() : undefined;
  };

  const destination = getField('Destination') || getField('Destination Country') || '[Destination]';
  const visaType = getField('Visa Type') || 'Visitor';

  const refusalPresent =
    /(^|\n)\s*Visa Refusals:/i.test(joined) ||
    /(^|\n)\s*Previous Visa Refusals/i.test(joined) ||
    /\brefusal(s)?\b/i.test(joined) ||
    (intentFlags?.applicationType === 'Reapplication');

  const sponsored =
    /(^|\n)\s*Self-sponsored:\s*No/i.test(joined) ||
    /(^|\n)\s*Sponsor Name:/i.test(joined) ||
    (intentFlags?.isSponsored === 'Yes');

  const selfEmployed =
    /(^|\n)\s*Occupation:\s*(owner|self|founder|ceo|proprietor)/i.test(joined) ||
    (intentFlags?.employmentStatus && intentFlags.employmentStatus.toLowerCase().includes('self'));

  const businessPurpose =
    /(^|\n)\s*Purpose of Travel:\s*.*(business|conference|training)/i.test(joined) ||
    /Visa Type:\s*Business/i.test(joined);

  const medicalPurpose =
    /(^|\n).*(Medical:|medical)/i.test(joined) ||
    /(^|\n)\s*Purpose of Travel:\s*.*medical/i.test(joined) ||
    /Visa Type:\s*Medical/i.test(joined);

  const hasTravelHistory = /(^|\n)\s*Travel History:\s*\S+/i.test(joined);
  const touristFirstTime = !hasTravelHistory && /(^|\n)\s*Purpose of Travel:\s*.*(tourism|holiday|visit)/i.test(joined);

  const hasTies = /Property Details:|Family\/Dependents:|Business\/Employment Commitments:/i.test(joined);
  const hasWeaknesses = /(^|\n)\s*Potential Weaknesses:\s*\S+/i.test(joined);
  const hasCompelling = /(^|\n)\s*Compelling Reasons:\s*\S+/i.test(joined);

  const currencyHintPresent =
    containsForeignCurrencyHint(joined) ||
    containsForeignCurrencyHint(getField('Bank Statement Details')) ||
    containsForeignCurrencyHint(getField('Monthly Income'));

  const toneHint = (hasCompelling || hasWeaknesses || medicalPurpose)
    ? 'Warm, empathetic yet professional. Acknowledge context briefly without over-sharing.'
    : 'Formal, respectful, confident.';

  const scenarioHints = [];
  const blocks = [];

  if (refusalPresent) {
    scenarioHints.push('Reapplication after refusal: briefly address each point and show new evidence only.');
    if (mini.refusal) blocks.push('--- MINI (Reapplication) ---\n' + mini.refusal);
  }
  if (sponsored) {
    scenarioHints.push('Sponsored: clearly state sponsor identity, relationship, income, accommodation, and sponsor documents.');
    if (mini.sponsor) blocks.push('--- MINI (Sponsored) ---\n' + mini.sponsor);
  }
  if (selfEmployed) {
    scenarioHints.push('Self-employed: reference CAC/registration, tax returns, invoices if provided.');
    if (mini.selfEmp) blocks.push('--- MINI (Self-employed) ---\n' + mini.selfEmp);
  }
  if (businessPurpose) {
    scenarioHints.push('Business/Conference: include event name, dates, invitation, and who covers costs.');
    if (mini.business) blocks.push('--- MINI (Business/Conference) ---\n' + mini.business);
  }
  if (medicalPurpose) {
    scenarioHints.push('Medical: include hospital/appointment details, timeline, and funding source.');
    if (mini.medical) blocks.push('--- MINI (Medical) ---\n' + mini.medical);
  }
  if (touristFirstTime) {
    scenarioHints.push('Tourist, first-time traveler: reassure ties and capability; tone welcoming but formal.');
    if (mini.touristFirst) blocks.push('--- MINI (Tourist First-time) ---\n' + mini.touristFirst);
  }
  if (hasTies) {
    scenarioHints.push('Emphasize strong ties to Nigeria (family, employment/business, property, commitments).');
  }

  const systemMessage = {
    role: 'system',
    content:
      `You are an expert consular assistant. Write embassy-acceptable visa cover letters for Nigeria-based applicants.
Use ${toneHint}
Do NOT invent facts. Keep paragraphs short, precise, and readable.

Currency policy:
- Default to Nigerian Naira (₦) formatting in amounts unless a different currency is explicitly present in the user's input.
- If the user typed other symbols (e.g., $, £, €) or codes (USD, GBP, EUR), keep their original currency as written.

Style policy:
- Synthesize style from provided samples without copying lines verbatim.
- Avoid flowery language; be human, sincere, and clear.
- Never contradict the intake; omit any section with missing data.`
  };

  const guide = {
    role: 'user',
    content:
`STRUCTURE (Plain text only):
1) Applicant contact (if provided) + current date
2) Embassy block (if provided)
3) Subject: "Application for ${visaType} Visa to ${destination}"
4) Salutation
5) Body:
   - Identity & travel dates
   - Employment/Business & income
   - Funding & accommodation
   - Refusal rebuttal (if any)
   - Supporting documents referenced
   - Strong ties & return assurance
6) Closing: "Sincerely," + full name

--- RULES (clipped) ---
${clip(ASSETS.masterRules, 3000)}

--- STRUCTURE GUIDE (clipped) ---
${clip(ASSETS.structureGuide, 1800)}

--- QUALITY CHECKLIST (clipped) ---
${clip(ASSETS.qualityChecklist, 1200)}

--- MASTER TEMPLATE (clipped, adapt; do not copy) ---
${clip(ASSETS.masterTemplate, 2500)}

--- STYLE DIGEST (samples) ---
${styleDigest || '(samples loaded but digest clipped)'}
${blocks.length ? '\n\n' + blocks.join('\n\n') : ''}

--- SCENARIO HINTS ---
${scenarioHints.length ? '- ' + scenarioHints.join('\n- ') : '(none)'}

--- CURRENCY HINT ---
${currencyHintPresent ? 'User input contains non-Naira currency symbols/codes. Preserve those as written.' : 'Use ₦ for amounts unless the intake explicitly shows another currency.'}
`
  };

  const userInstruction = {
    role: 'user',
    content:
`Use ONLY these facts (omit fields not provided). Do not hallucinate.

${detailLines.map((l) => '- ' + l).join('\n')}

OUTPUT:
Return one cohesive plain-text cover letter.`
  };

  return [systemMessage, guide, userInstruction];
}

/* ------------------------ Model call ------------------------ */
async function createLetter(messages) {
  const isGPT5Mini = /^gpt-5-mini/.test(MODEL_NAME);
  try {
    if (isGPT5Mini) {
      const resp = await openai.chat.completions.create({
        model: MODEL_NAME,
        messages,
        // max_completion_tokens: 900, // optional cap for long letters
      });
      return resp.choices?.[0]?.message?.content?.trim();
    } else {
      const resp = await openai.chat.completions.create({
        model: MODEL_NAME,
        messages,
        temperature: 0.2,
        max_tokens: 900,
      });
      return resp.choices?.[0]?.message?.content?.trim();
    }
  } catch (err) {
    console.error('Primary model failed:', err?.message || err);
    if (FALLBACK_MODEL && FALLBACK_MODEL !== MODEL_NAME) {
      const resp = await openai.chat.completions.create({
        model: FALLBACK_MODEL,
        messages,
        temperature: 0.2,
        max_tokens: 900,
      });
      return resp.choices?.[0]?.message?.content?.trim();
    }
    throw err;
  }
}

/* ------------------------ Health & Assets ------------------------ */
app.get('/', (_req, res) => res.send('✅ Visa Letter API is running'));
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    model: MODEL_NAME,
    rulesLoaded: REQ_RULES.length + 1, // + master template
    miniTemplatesLoaded: Object.keys(ASSETS.minis).length,
    samplesLoaded: ASSETS.samples.length,
  });
});
app.get('/assets', (_req, res) => {
  res.json({
    rules: {
      master_rules: !!ASSETS.masterRules,
      structure_guide: !!ASSETS.structureGuide,
      quality_checklist: !!ASSETS.qualityChecklist,
      master_template: !!ASSETS.masterTemplate,
    },
    mini_templates: Object.keys(ASSETS.minis),
    samples: ASSETS.samples.map(f => f.name),
  });
});

/* ------------------------ Main Endpoint ------------------------ */
app.post('/generate-letter', async (req, res) => {
  try {
    const b = req.body || {};

    const payload = {
      // Personal
      name: clean(b.name),
      age: clean(b.age),
      nationality: clean(b.nationality),
      applicantAddress: clean(b.applicantAddress),
      contactPhone: clean(b.contactPhone),
      contactEmail: clean(b.contactEmail),
      dateOfBirth: clean(b.dateOfBirth),
      passportNumber: clean(b.passportNumber),
      passportIssueDate: clean(b.passportIssueDate),
      passportExpiryDate: clean(b.passportExpiryDate),
      maritalStatus: clean(b.maritalStatus),
      numDependents: clean(b.numDependents),

      // Travel
      destination: clean(b.destination),
      visaType: clean(b.visaType),
      purpose: clean(b.purpose),
      travelDates: clean(b.travelDates),
      entryDate: clean(b.entryDate),
      stayDuration: clean(b.stayDuration),
      invited: clean(b.invited),
      inviterName: clean(b.inviterName),
      inviterAddress: clean(b.inviterAddress),
      inviterRelationship: clean(b.inviterRelationship),
      inviterDocs: clean(b.inviterDocs),
      stayDetails: clean(b.stayDetails),
      travelItinerary: clean(b.travelItinerary),

      // Employment & Finances
      occupation: clean(b.occupation),
      employerName: clean(b.employerName),
      employerAddress: clean(b.employerAddress),
      employmentDuration: clean(b.employmentDuration),
      income: clean(b.income),
      otherIncome: clean(b.otherIncome),
      funding: clean(b.funding),
      bankStatementDetails: clean(b.bankStatementDetails),
      significantTransactions: clean(b.significantTransactions),
      monthlyExpenses: clean(b.monthlyExpenses),
      currentBankBalance: clean(b.currentBankBalance),
      estimatedTripCost: clean(b.estimatedTripCost),

      // Ties
      propertyDetails: clean(b.propertyDetails),
      businessCommitments: clean(b.businessCommitments),
      familyDependents: clean(b.familyDependents),
      otherCommitments: clean(b.otherCommitments),

      // History
      travelHistory: clean(b.travelHistory),
      visaRefusals: clean(b.visaRefusals),
      validVisas: clean(b.validVisas),

      // Sponsor
      sponsorSelf: clean(b.sponsorSelf),
      sponsorName: clean(b.sponsorName),
      sponsorRelationship: clean(b.sponsorRelationship),
      sponsorOccupation: clean(b.sponsorOccupation),
      sponsorIncome: clean(b.sponsorIncome),
      sponsorAccommodation: clean(b.sponsorAccommodation),
      sponsorDocs: clean(b.sponsorDocs),

      // Additional
      specialEvents: clean(b.specialEvents),
      compellingReasons: clean(b.compellingReasons),
      supportingLetters: clean(b.supportingLetters),
      potentialWeaknesses: clean(b.potentialWeaknesses),

      // Existing
      accommodation: clean(b.accommodation),
      documents: clean(b.documents),
      embassyName: clean(b.embassyName),
      embassyAddress: clean(b.embassyAddress),
      companyName: clean(b.companyName) || 'No Guide Travel Agent',
    };

    // Required intake (unchanged, but stricter messages)
    const required = ['name', 'age', 'nationality', 'destination', 'visaType', 'purpose', 'income'];
    const missing = required.filter((k) => !payload[k]);
    if (missing.length) {
      return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    }

    // Build detail lines for the prompt
    const d = [];
    d.push(`Full Name: ${payload.name}`);
    d.push(`Age: ${payload.age}`);
    d.push(`Nationality: ${payload.nationality}`);
    if (payload.dateOfBirth) d.push(`Date of Birth: ${payload.dateOfBirth}`);
    if (payload.passportNumber) d.push(`Passport Number: ${payload.passportNumber}`);
    if (payload.passportIssueDate) d.push(`Passport Issue Date: ${payload.passportIssueDate}`);
    if (payload.passportExpiryDate) d.push(`Passport Expiry Date: ${payload.passportExpiryDate}`);
    if (payload.maritalStatus) d.push(`Marital Status: ${payload.maritalStatus}`);
    if (payload.numDependents) d.push(`Number of Dependents: ${payload.numDependents}`);
    if (payload.applicantAddress) d.push(`Address: ${payload.applicantAddress}`);
    if (payload.contactPhone) d.push(`Phone: ${payload.contactPhone}`);
    if (payload.contactEmail) d.push(`Email: ${payload.contactEmail}`);

    d.push(`Destination: ${payload.destination}`);
    d.push(`Visa Type: ${payload.visaType}`);
    if (payload.travelDates) d.push(`Travel Dates: ${payload.travelDates}`);
    if (payload.entryDate) d.push(`Entry Date: ${payload.entryDate}`);
    if (payload.stayDuration) d.push(`Duration of Stay: ${payload.stayDuration}`);
    d.push(`Purpose of Travel: ${payload.purpose}`);
    if (payload.invited) d.push(`Invited by someone in destination country?: ${payload.invited}`);
    if (payload.inviterName) d.push(`Inviter Name: ${payload.inviterName}`);
    if (payload.inviterAddress) d.push(`Inviter Address: ${payload.inviterAddress}`);
    if (payload.inviterRelationship) d.push(`Inviter Relationship: ${payload.inviterRelationship}`);
    if (payload.inviterDocs) d.push(`Inviter Documents: ${payload.inviterDocs}`);
    if (payload.stayDetails) d.push(`Stay Details: ${payload.stayDetails}`);
    if (payload.travelItinerary) d.push(`Travel Itinerary: ${payload.travelItinerary}`);

    if (payload.occupation) d.push(`Occupation: ${payload.occupation}`);
    if (payload.employerName) d.push(`Employer/Business Name: ${payload.employerName}`);
    if (payload.employerAddress) d.push(`Employer/Business Address: ${payload.employerAddress}`);
    if (payload.employmentDuration) d.push(`Employment Duration: ${payload.employmentDuration}`);
    d.push(`Monthly Income: ${payload.income}`);
    if (payload.otherIncome) d.push(`Other Income: ${payload.otherIncome}`);
    d.push(`Funding Source: ${payload.funding || 'Self-funded'}`);
    if (payload.bankStatementDetails) d.push(`Bank Statement Details: ${payload.bankStatementDetails}`);
    if (payload.monthlyExpenses) d.push(`Monthly Expenses: ${payload.monthlyExpenses}`);
    if (payload.currentBankBalance) d.push(`Current Bank Balance: ${payload.currentBankBalance}`);
    if (payload.estimatedTripCost) d.push(`Estimated Trip Cost: ${payload.estimatedTripCost}`);
    if (payload.significantTransactions) d.push(`Significant Transactions: ${payload.significantTransactions}`);

    if (payload.accommodation) d.push(`Accommodation: ${payload.accommodation}`);
    if (payload.documents) d.push(`Supporting Documents: ${payload.documents}`);

    if (payload.propertyDetails) d.push(`Property Details: ${payload.propertyDetails}`);
    if (payload.businessCommitments) d.push(`Business/Employment Commitments: ${payload.businessCommitments}`);
    if (payload.familyDependents) d.push(`Family/Dependents: ${payload.familyDependents}`);
    if (payload.otherCommitments) d.push(`Other Commitments: ${payload.otherCommitments}`);

    if (payload.travelHistory) d.push(`Travel History: ${payload.travelHistory}`);
    if (payload.visaRefusals) d.push(`Visa Refusals: ${payload.visaRefusals}`);
    if (payload.validVisas) d.push(`Valid Visas: ${payload.validVisas}`);

    if (payload.sponsorSelf) d.push(`Self-sponsored: ${payload.sponsorSelf}`);
    if (payload.sponsorName) d.push(`Sponsor Name: ${payload.sponsorName}`);
    if (payload.sponsorRelationship) d.push(`Sponsor Relationship: ${payload.sponsorRelationship}`);
    if (payload.sponsorOccupation) d.push(`Sponsor Occupation: ${payload.sponsorOccupation}`);
    if (payload.sponsorIncome) d.push(`Sponsor Income: ${payload.sponsorIncome}`);
    if (payload.sponsorAccommodation) d.push(`Sponsor Accommodation Provided?: ${payload.sponsorAccommodation}`);
    if (payload.sponsorDocs) d.push(`Sponsor Documents: ${payload.sponsorDocs}`);

    if (payload.specialEvents) d.push(`Special Events: ${payload.specialEvents}`);
    if (payload.compellingReasons) d.push(`Compelling Reasons: ${payload.compellingReasons}`);
    if (payload.supportingLetters) d.push(`Supporting Letters/Docs: ${payload.supportingLetters}`);
    if (payload.potentialWeaknesses) d.push(`Potential Weaknesses: ${payload.potentialWeaknesses}`);

    d.push(`Company: ${payload.companyName}`);
    if (payload.embassyName) d.push(`Embassy Name: ${payload.embassyName}`);
    if (payload.embassyAddress) d.push(`Embassy Address: ${payload.embassyAddress}`);

    // Intent flags for smarter prompt
    const flags = {
      applicationType: (/reapp/i.test(String(payload.visaRefusals || '')) ? 'Reapplication' : undefined),
      employmentStatus: undefined, // frontend already embeds a hint in bank details; optional here
      isSponsored: (payload.sponsorSelf === 'No' ? 'Yes' : 'No'),
    };

    const messages = buildMessages(d, flags);
    const letter = await createLetter(messages);
    if (!letter) return res.status(502).json({ error: 'The AI returned no content.' });

    return res.json({ letter });
  } catch (err) {
    console.error('Error generating letter:', err?.message || err);
    const status = err?.status || err?.statusCode || 500;
    return res.status(status).json({
      error: 'Failed to generate letter',
      detail: err?.message || 'unknown_error',
    });
  }
});

/* ------------------------ Start ------------------------ */
app.listen(PORT, () => {
  console.log(`✅ Visa Letter API listening on http://localhost:${PORT}`);
});
