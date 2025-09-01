/**
 * Visa Letter API — Render-ready (SOP-aware)
 * - CORS allow-list for your Static Site (via FRONTEND_ORIGIN)
 * - Reads SOP rules, mini-templates, and sample letters from /rules, /mini_templates, /samples
 * - Works with gpt-5-mini (no temperature/max_tokens); graceful fallback
 * - Clear errors for debugging
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
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || ''; // e.g. https://visa-cover-letter-api-1.onrender.com

// ------------------------ App & Middleware ------------------------
const app = express();
const PORT = process.env.PORT || 5000;

// CORS: allow your Static Site + localhost dev; otherwise allow all (dev)
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
  // Permissive for local/dev; lock down later by setting FRONTEND_ORIGIN
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

// ------------------------ SOP Assets: Rules, Minis, Samples ------------------------
const RULES_DIR = path.join(__dirname, 'rules');
const MINIS_DIR = path.join(__dirname, 'mini_templates');
const SAMPLES_DIR = path.join(__dirname, 'samples');

// Create folders if missing (safe no-ops if they exist)
for (const d of [RULES_DIR, MINIS_DIR, SAMPLES_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function readAllTxt(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /\.(txt|md)$/i.test(f))
    .map((name) => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8') }));
}

function readFirstExisting(dir, names = []) {
  for (const n of names) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  return '';
}

function clip(text = '', max = 4000) {
  const s = String(text || '');
  return s.length <= max ? s.trim() : (s.slice(0, max).trim() + '\n…');
}

// Build a compact "style digest" from samples to keep tokens low
function buildStyleDigest({ maxFiles = 8, perFileChars = 800, totalChars = 4000 } = {}) {
  const files = readAllTxt(SAMPLES_DIR).slice(0, maxFiles);
  let out = '';
  for (let i = 0; i < files.length; i++) {
    const chunk = clip(files[i].text, perFileChars);
    const next = `\n\n### Sample ${i + 1}: ${files[i].name}\n${chunk}`;
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

// 👇 REWORKED: buildMessages now injects RULES + SAMPLES + SCENARIOS
function buildMessages(details) {
  // Pull SOP assets (optional; safe if missing)
  const masterRules = clip(readFirstExisting(RULES_DIR, ['master_rules.txt']), 3000);
  const structureGuide = clip(readFirstExisting(RULES_DIR, ['structure_guide.txt']), 1800);
  const qualityChecklist = clip(readFirstExisting(RULES_DIR, ['quality_checklist.txt']), 1200);
  const decisionTree = clip(readFirstExisting(RULES_DIR, ['decision_tree.txt']), 1800);

  const miniRefusal = clip(readFirstExisting(MINIS_DIR, ['refusal_reapplication.txt']), 1200);
  const miniSponsor = clip(readFirstExisting(MINIS_DIR, ['sponsor_guidelines.txt']), 1200);
  const miniSelfEmp = clip(readFirstExisting(MINIS_DIR, ['self_employed.txt']), 1200);

  const styleDigest = buildStyleDigest();

  // Infer scenario and context from the already-built detail lines
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
    /Refusal/i.test(joined);

  const sponsored =
    /(^|\n)\s*Self-sponsored:\s*No/i.test(joined) ||
    /(^|\n)\s*Sponsor Name:/i.test(joined);

  const selfEmployed =
    /(^|\n)\s*Occupation:\s*(owner|self|founder|ceo)/i.test(joined);

  const businessPurpose =
    /(^|\n)\s*Purpose of Travel:\s*.*(business|conference)/i.test(joined);

  const medicalPurpose = /(^|\n).*(Medical:|medical)/i.test(joined);

  const strongTies =
    /Property Details:|Family\/Dependents:|Business\/Employment Commitments:/i.test(joined);

  const hasWeaknesses =
    /(^|\n)\s*Potential Weaknesses:/i.test(joined);

  // Tone hint: a touch warmer when sensitive
  const toneHint = hasWeaknesses || medicalPurpose ? 'Warm, empathetic but professional.' : 'Formal, respectful, confident.';

  // Scenario hints to steer the model per SOP
  const scenarioHints = [];
  if (refusalPresent) scenarioHints.push('Reapplication after refusal: include a brief rebuttal addressing the exact refusal points (no excuses, just clear corrections and evidence).');
  if (sponsored) scenarioHints.push('Sponsored: clearly state sponsor identity, relationship, income, accommodation, and list sponsor documents referenced.');
  if (selfEmployed) scenarioHints.push('Self-employed: reference business registration (CAC), tax returns, and invoices if provided.');
  if (businessPurpose) scenarioHints.push('Business/Conference: include event name, dates, invitation and funding responsibility.');
  if (medicalPurpose) scenarioHints.push('Medical: include hospital/appointment details, timeline, and who covers costs.');
  if (strongTies) scenarioHints.push('Emphasize strong ties to Nigeria (family, employment/business, property, commitments) and clear intention to return.');

  // Assemble optional scenario mini-templates
  const scenarioBlocks = [];
  if (refusalPresent && miniRefusal) scenarioBlocks.push('--- MINI TEMPLATE (Reapplication) ---\n' + miniRefusal);
  if (sponsored && miniSponsor) scenarioBlocks.push('--- MINI TEMPLATE (Sponsored) ---\n' + miniSponsor);
  if (selfEmployed && miniSelfEmp) scenarioBlocks.push('--- MINI TEMPLATE (Self-employed) ---\n' + miniSelfEmp);

  const systemMessage = {
    role: 'system',
    content:
      'You are an expert consular assistant. Write embassy-acceptable visa cover letters. Use a ' +
      toneHint +
      ' Keep paragraphs short and clear. Never invent facts. Synthesize STYLE from samples without copying lines.'
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

--- RULES (SOP, clipped) ---
${masterRules || '(no extra rules provided)'}

${structureGuide ? '\n--- STRUCTURE GUIDE (clipped) ---\n' + structureGuide : ''}
${qualityChecklist ? '\n--- QUALITY CHECKLIST (clipped) ---\n' + qualityChecklist : ''}
${decisionTree ? '\n--- DECISION TREE (clipped) ---\n' + decisionTree : ''}

--- STYLE DIGEST (excerpts from samples, clipped) ---
${styleDigest || '(no samples found)'}
${scenarioBlocks.length ? '\n\n' + scenarioBlocks.join('\n\n') : ''}

--- SCENARIO HINTS (derived from intake) ---
${scenarioHints.length ? '- ' + scenarioHints.join('\n- ') : '(none)'}
`
  };

  const userInstruction = {
    role: 'user',
    content: `Use ONLY these facts (omit fields not provided). Do not hallucinate.

${details.map((l) => '- ' + l).join('\n')}

OUTPUT:
Return one cohesive plain-text cover letter.`
  };

  return [systemMessage, guide, userInstruction];
}

// Use gpt-5-mini safely (no temperature/max_tokens); fallback once if needed
async function createLetter(messages) {
  const isGPT5Mini = /^gpt-5-mini/.test(MODEL_NAME);

  try {
    if (isGPT5Mini) {
      const resp = await openai.chat.completions.create({
        model: MODEL_NAME,
        messages,
        // For length limiting with gpt-5-mini, you can optionally set:
        // max_completion_tokens: 900,
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

      // Existing fields
      accommodation: clean(b.accommodation),
      documents: clean(b.documents),
      embassyName: clean(b.embassyName),
      embassyAddress: clean(b.embassyAddress),
      companyName: clean(b.companyName) || 'No Guide Travel Agent',
    };

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
    d.push(`Monthly Income: ${payload.income}`);
    if (payload.otherIncome) d.push(`Other Income: ${payload.otherIncome}`);
    d.push(`Funding Source: ${payload.funding || 'Self-funded'}`);
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

    const messages = buildMessages(d);
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
