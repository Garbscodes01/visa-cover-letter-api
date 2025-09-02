/**
 * Visa Letter API — SOP-enforced (no currency conversion)
 * - Reads & REQUIRES: /rules, /mini_templates, /samples
 * - If SOP assets missing -> 503 with clear list
 * - gpt-5-mini by default (safe params)
 * - Output stays in whatever currency staff typed (no normalization)
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');

// ------------------------ Load .env for local dev ------------------------
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

// ------------------------ Required env ------------------------
if (!process.env.OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY');
  process.exit(1);
}

const MODEL_NAME = process.env.MODEL_NAME || 'gpt-5-mini';
const FALLBACK_MODEL = process.env.FALLBACK_MODEL || 'gpt-4o-mini';
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || ''; // e.g. https://your-frontend.onrender.com

// ------------------------ App & Middleware ------------------------
const app = express();
const PORT = process.env.PORT || 5000;

// CORS
if (FRONTEND_ORIGIN) {
  const allowedOrigins = new Set([
    FRONTEND_ORIGIN,
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ]);
  app.use(
    cors({
      origin(origin, cb) {
        if (!origin) return cb(null, true); // Postman/cURL
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

// ------------------------ OpenAI Client ------------------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  organization: process.env.OPENAI_ORG_ID || process.env.OPENAI_ORG || undefined,
  project: process.env.OPENAI_PROJECT_ID || process.env.OPENAI_PROJECT || undefined,
});

// ------------------------ SOP Assets (MANDATORY) ------------------------
const RULES_DIR = path.join(__dirname, 'rules');
const MINIS_DIR = path.join(__dirname, 'mini_templates');
const SAMPLES_DIR = path.join(__dirname, 'samples');
for (const d of [RULES_DIR, MINIS_DIR, SAMPLES_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const REQUIRED_RULE_FILES = [
  'master_rules.txt',
  // allow either spelling for the master template
  ['master_template.txt', 'master_templete.txt'],
  'structure_guide.txt',
  'quality_checklist.txt',
];

const REQUIRED_MINI_FILES = [
  'refusal_reapplication.txt',
  'sponsor_guidelines.txt',
  'self_employed.txt',
  'tourist_first_time.txt',
  'business_conference.txt',
  'medical_visit.txt',
];

const MIN_SAMPLES = 1;

function readFileSafe(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

function clip(text = '', max = 4000) {
  const s = String(text || '');
  return s.length <= max ? s.trim() : (s.slice(0, max).trim() + '\n…');
}

function checkAndLoadSOP() {
  const missing = [];

  // rules
  const rules = {};
  for (const rf of REQUIRED_RULE_FILES) {
    if (Array.isArray(rf)) {
      const candidate = rf.find((n) => fs.existsSync(path.join(RULES_DIR, n)));
      if (!candidate) {
        missing.push(`rules/${rf.join(' OR ')}`);
      } else {
        rules['master_template'] = readFileSafe(path.join(RULES_DIR, candidate));
      }
    } else {
      const p = path.join(RULES_DIR, rf);
      if (!fs.existsSync(p)) missing.push(`rules/${rf}`);
      else rules[rf.replace('.txt', '')] = readFileSafe(p);
    }
  }

  // minis
  const minis = {};
  for (const mf of REQUIRED_MINI_FILES) {
    const p = path.join(MINIS_DIR, mf);
    if (!fs.existsSync(p)) missing.push(`mini_templates/${mf}`);
    else minis[mf.replace('.txt', '')] = readFileSafe(p);
  }

  // samples
  const sampleFiles = fs.readdirSync(SAMPLES_DIR).filter((f) => /\.(txt|md)$/i.test(f));
  if (sampleFiles.length < MIN_SAMPLES) {
    missing.push(`samples/* (at least ${MIN_SAMPLES} file)`);
  }
  const samples = sampleFiles.map((name) => ({
    name,
    text: readFileSafe(path.join(SAMPLES_DIR, name)),
  }));

  return { ok: missing.length === 0, missing, rules, minis, samples };
}

function buildStyleDigest(samples, { maxFiles = 8, perFileChars = 800, totalChars = 4000 } = {}) {
  const take = samples.slice(0, maxFiles);
  let out = '';
  for (let i = 0; i < take.length; i++) {
    const chunk = clip(take[i].text, perFileChars);
    const next = `\n\n### Sample ${i + 1}: ${take[i].name}\n${chunk}`;
    if ((out + next).length > totalChars) break;
    out += next;
  }
  return out.trim();
}

// ------------------------ Utilities ------------------------
function clean(v) {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}

function compileSupportingDocs(payload) {
  const docs = new Set();
  if (payload.documents) docs.add(payload.documents);
  if (payload.sponsorDocs) docs.add(payload.sponsorDocs);
  if (payload.inviterDocs) docs.add(payload.inviterDocs);
  if (payload.supportingLetters) docs.add(payload.supportingLetters);
  if (payload.bankStatementDetails) docs.add('Bank statements');
  if (payload.income) docs.add('Payslips / income evidence');

  if (/owner|self|founder|ceo|proprietor/i.test(payload.occupation || '')) {
    docs.add('CAC registration / business documents');
    docs.add('Tax returns / invoices');
  }
  if (payload.propertyDetails) docs.add('Property ownership documents');
  if (payload.familyDependents) docs.add('Family evidence (marriage/birth certificates)');
  if (payload.visaRefusals) docs.add('Previous refusal letter & rebuttal evidence');
  if (payload.validVisas) docs.add('Copies of valid visas');

  return Array.from(docs)
    .map((s) => s.trim())
    .filter(Boolean)
    .join('; ');
}

// ---------- Prompt Builder (SOP-enforced) ----------
function buildMessages(details, sop) {
  // extract some fields for titles and tone selection
  const joined = details.join('\n');
  const getField = (label) => {
    const m = new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*(.+)$', 'mi').exec(joined);
    return m ? m[1].trim() : undefined;
  };
  const destination = getField('Destination') || getField('Destination Country') || '[Destination]';
  const visaType = getField('Visa Type') || 'Visitor';

  const refusalPresent =
    /(^|\n)\s*Visa Refusals:/i.test(joined) ||
    /(^|\n)\s*Previous Visa Refusals/i.test(joined) ||
    /\brefusal(s)?\b/i.test(joined);

  const sponsored =
    /(^|\n)\s*Self-sponsored:\s*No/i.test(joined) ||
    /(^|\n)\s*Sponsor Name:/i.test(joined) ||
    /(^|\n)\s*Spons(or|orship)/i.test(joined);

  const selfEmployed =
    /(^|\n)\s*Occupation:\s*(owner|self|founder|ceo|proprietor)/i.test(joined);

  const businessPurpose =
    /(^|\n)\s*Purpose of Travel:\s*.*(business|conference|training)/i.test(joined);

  const medicalPurpose =
    /(^|\n).*(Medical:|medical)/i.test(joined) ||
    /(^|\n)\s*Purpose of Travel:\s*.*medical/i.test(joined);

  const hasTravelHistory = /(^|\n)\s*Travel History:\s*\S+/i.test(joined);
  const touristFirstTime = !hasTravelHistory && /(^|\n)\s*Purpose of Travel:\s*.*(tourism|holiday|visit)/i.test(joined);

  const hasWeaknesses =
    /(^|\n)\s*Potential Weaknesses:\s*\S+/i.test(joined);

  const toneHint = (hasWeaknesses || medicalPurpose)
    ? 'Warm, empathetic, and respectful; human but professional.'
    : 'Formal, respectful, reassuring; concise and confident.';

  // Build scenario hints + include minis (MANDATORY)
  const scenarioHints = [];
  const blocks = [];

  if (refusalPresent) {
    scenarioHints.push('Reapplication: briefly address refusal points and present new evidence factually.');
    blocks.push('--- MINI (Reapplication) ---\n' + clip(sop.minis['refusal_reapplication'], 1200));
  }
  if (sponsored) {
    scenarioHints.push('Sponsored: clearly state sponsor identity, relationship, income, whether accommodation is provided, and list sponsor documents.');
    blocks.push('--- MINI (Sponsored) ---\n' + clip(sop.minis['sponsor_guidelines'], 1200));
  }
  if (selfEmployed) {
    scenarioHints.push('Self-employed: refer to CAC/registration, tax returns, invoices where relevant.');
    blocks.push('--- MINI (Self-employed) ---\n' + clip(sop.minis['self_employed'], 1200));
  }
  if (businessPurpose) {
    scenarioHints.push('Business/Conference: include event name, dates, invitation, and who covers costs.');
    blocks.push('--- MINI (Business/Conference) ---\n' + clip(sop.minis['business_conference'], 900));
  }
  if (medicalPurpose) {
    scenarioHints.push('Medical: include hospital/appointment details, timeline, and funding source.');
    blocks.push('--- MINI (Medical) ---\n' + clip(sop.minis['medical_visit'], 900));
  }
  if (touristFirstTime) {
    scenarioHints.push('Tourist first-time: emphasise financial capability and ties; tone calm and reassuring.');
    blocks.push('--- MINI (Tourist First-time) ---\n' + clip(sop.minis['tourist_first_time'], 900));
  }

  const styleDigest = buildStyleDigest(sop.samples);

  const systemMessage = {
    role: 'system',
    content:
      'You are an expert consular assistant. Produce embassy-acceptable visa cover letters. Use a ' +
      toneHint +
      ' Keep paragraphs short and clear. Never invent facts or numbers. DO NOT convert currencies or fabricate exchange rates; write amounts exactly as provided.',
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
   - Employment/Business & income (write amounts exactly as given; no conversion)
   - Funding & accommodation (sponsor vs self-funded clarity)
   - Refusal rebuttal (if any)
   - Supporting documents referenced
   - Strong ties & return assurance
6) Closing: "Sincerely," + full name

--- MASTER RULES (required, clipped) ---
${clip(sop.rules['master_rules'], 3000)}

--- STRUCTURE GUIDE (required, clipped) ---
${clip(sop.rules['structure_guide'], 1800)}

--- QUALITY CHECKLIST (required, clipped) ---
${clip(sop.rules['quality_checklist'], 1200)}

--- MASTER TEMPLATE (required, clipped; adapt, do not copy) ---
${clip(sop.rules['master_template'], 2500)}

--- STYLE DIGEST (sample excerpts; required) ---
${styleDigest || '(no samples digest)'}
${blocks.length ? '\n\n' + blocks.join('\n\n') : ''}

--- SCENARIO HINTS ---
${scenarioHints.length ? '- ' + scenarioHints.join('\n- ') : '(none)'}
`
  };

  const userInstruction = {
    role: 'user',
    content: `Use ONLY these facts (omit fields not provided). Do not hallucinate. Do not convert currencies.

${details.map((l) => '- ' + l).join('\n')}

OUTPUT:
Return one cohesive plain-text cover letter. End with a short "Supporting Documents" list.`
  };

  return [systemMessage, guide, userInstruction];
}

// ------------------------ Model call ------------------------
async function createLetter(messages) {
  const isGPT5Mini = /^gpt-5-mini/.test(MODEL_NAME);
  try {
    if (isGPT5Mini) {
      const resp = await openai.chat.completions.create({
        model: MODEL_NAME,
        messages,
        // Keep the defaults for determinism; mini is stable without temperature/max_tokens.
        // max_completion_tokens: 900, // optional if you want a hard cap
      });
      return resp.choices?.[0]?.message?.content?.trim();
    } else {
      const resp = await openai.chat.completions.create({
        model: MODEL_NAME,
        messages,
        temperature: 0.2,
        max_tokens: 800,
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
        max_tokens: 800,
      });
      return resp.choices?.[0]?.message?.content?.trim();
    }
    throw err;
  }
}

// ------------------------ Health ------------------------
app.get('/', (_req, res) => res.send('✅ Visa Letter API is running'));
app.get('/health', (_req, res) => res.json({ ok: true, model: MODEL_NAME }));

// ------------------------ Main Endpoint ------------------------
app.post('/generate-letter', async (req, res) => {
  try {
    // 1) Enforce SOP assets before anything else
    const sop = checkAndLoadSOP();
    if (!sop.ok) {
      console.error('❌ Missing SOP assets:', sop.missing);
      return res
        .status(503)
        .json({ error: 'SOP assets missing', missing: sop.missing });
    }

    // 2) Intake & validation
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

      // Optional field in case your form adds it later
      estimatedTripCost: clean(b.estimatedTripCost),
    };

    const required = ['name', 'age', 'nationality', 'destination', 'visaType', 'purpose', 'income'];
    const missingReq = required.filter((k) => !payload[k]);
    if (missingReq.length) {
      return res.status(400).json({ error: `Missing required fields: ${missingReq.join(', ')}` });
    }

    // 3) Build prompt facts
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
    if (payload.invited) d.push(`Invited by someone in UK?: ${payload.invited}`);
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

    // IMPORTANT: No currency normalization — write as given
    d.push(`Monthly Income: ${payload.income}`);
    if (payload.otherIncome) d.push(`Other Income: ${payload.otherIncome}`);
    d.push(`Funding Source: ${payload.funding || 'Self-funded'}`);
    if (payload.estimatedTripCost) d.push(`Estimated Trip Cost: ${payload.estimatedTripCost}`);

    if (payload.bankStatementDetails) d.push(`Bank Statement Details: ${payload.bankStatementDetails}`);
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

    // Always add a single, grouped supporting docs line
    const groupedDocs = compileSupportingDocs(payload);
    if (groupedDocs) d.push(`Supporting Documents (Grouped): ${groupedDocs}`);

    // 4) Build messages with SOP content (MANDATORY in prompt)
    const messages = buildMessages(d, {
      rules: {
        master_rules: sop.rules['master_rules'],
        structure_guide: sop.rules['structure_guide'],
        quality_checklist: sop.rules['quality_checklist'],
        master_template: sop.rules['master_template'],
      },
      minis: {
        refusal_reapplication: sop.minis['refusal_reapplication'],
        sponsor_guidelines: sop.minis['sponsor_guidelines'],
        self_employed: sop.minis['self_employed'],
        tourist_first_time: sop.minis['tourist_first_time'],
        business_conference: sop.minis['business_conference'],
        medical_visit: sop.minis['medical_visit'],
      },
      samples: sop.samples,
    });

    // 5) Call model
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

// ------------------------ Start ------------------------
app.listen(PORT, () => {
  console.log(`✅ Visa Letter API listening on http://localhost:${PORT}`);
});
