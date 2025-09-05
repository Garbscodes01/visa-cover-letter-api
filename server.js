/**
 * Visa Letter API — SOP-STRICT, Nigeria-first, with Approval Rationale
 * --------------------------------------------------------------------
 * - Fails fast if required SOP assets are missing
 * - Reads /rules, /mini_templates, /samples (MANDATORY)
 * - Empathetic, scenario-aware prompt builder + "why approve" rationale
 * - Uses ₦ by default when staff didn’t specify a currency symbol
 * - Same external API: POST /generate-letter -> { letter }
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

// Strict CORS to your static origin (or permissive in dev if not set)
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

function requireFile(p, label) {
  if (!fs.existsSync(p)) {
    console.error(`❌ Missing required ${label}: ${p}`);
    process.exit(1);
  }
  return fs.readFileSync(p, 'utf8');
}
function requireAtLeastOneTxt(dir, label) {
  if (!fs.existsSync(dir)) {
    console.error(`❌ Missing required directory: ${dir} (${label})`);
    process.exit(1);
  }
  const files = fs.readdirSync(dir).filter((f) => /\.(txt|md)$/i.test(f));
  if (!files.length) {
    console.error(`❌ No .txt/.md files found in ${dir} (${label})`);
    process.exit(1);
  }
  return files.map((name) => ({
    name,
    text: fs.readFileSync(path.join(dir, name), 'utf8'),
  }));
}

function clip(text = '', max = 4000) {
  const s = String(text || '');
  return s.length <= max ? s.trim() : (s.slice(0, max).trim() + '\n…');
}

function loadSOPStrict() {
  // Required rule files
  const masterRules = requireFile(path.join(RULES_DIR, 'master_rules.txt'), 'rules/master_rules.txt');
  const structureGuide = requireFile(path.join(RULES_DIR, 'structure_guide.txt'), 'rules/structure_guide.txt');
  const qualityChecklist = requireFile(path.join(RULES_DIR, 'quality_checklist.txt'), 'rules/quality_checklist.txt');
  // Allow either spelling for master template
  let masterTemplate = '';
  const m1 = path.join(RULES_DIR, 'master_template.txt');
  const m2 = path.join(RULES_DIR, 'master_templete.txt');
  if (fs.existsSync(m1)) masterTemplate = fs.readFileSync(m1, 'utf8');
  else if (fs.existsSync(m2)) masterTemplate = fs.readFileSync(m2, 'utf8');
  else {
    console.error('❌ Missing required rules/master_template.txt (or master_templete.txt)');
    process.exit(1);
  }

  // Require at least one mini-template and one sample
  const minis = requireAtLeastOneTxt(MINIS_DIR, 'mini templates');
  const samples = requireAtLeastOneTxt(SAMPLES_DIR, 'samples');

  return { masterRules, structureGuide, qualityChecklist, masterTemplate, minis, samples };
}
const SOP = loadSOPStrict();

function buildStyleDigest(files, { maxFiles = 10, perFileChars = 900, totalChars = 5000 } = {}) {
  let out = '';
  const use = files.slice(0, maxFiles);
  for (let i = 0; i < use.length; i++) {
    const chunk = clip(use[i].text, perFileChars);
    const next = `\n\n### Sample ${i + 1}: ${use[i].name}\n${chunk}`;
    if ((out + next).length > totalChars) break;
    out += next;
  }
  return out.trim();
}
const STYLE_DIGEST = buildStyleDigest(SOP.samples);

// Quick index of minis by loose name
function getMini(namePart) {
  const hit = SOP.minis.find(f => f.name.toLowerCase().includes(namePart));
  return hit ? clip(hit.text, 1400) : '';
}

// ------------------------ Utilities ------------------------
function clean(v) {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}

// Parse a number from strings like "₦1,200,000", "£2,000", "2000000"
function parseNum(x) {
  if (!x) return NaN;
  const n = parseFloat(String(x).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

// Detect “sponsored” intent reliably
function isSponsoredPayload(b) {
  const f = (b.funding || '').toLowerCase();
  if (f === 'sponsor' || f === 'sponsored' || f === 'sponsorship' || f === 'family' || f === 'employer') return true;
  if (String(b.sponsorSelf || '').toLowerCase() === 'no') return true;
  if (b.sponsorName || b.sponsorRelationship) return true;
  return false;
}

// Decide app type from explicit field, or from refusals
function detectApplicationType(p) {
  const t = (p.applicationType || '').toLowerCase();
  if (t.includes('reapp')) return 'Reapplication';
  if (p.visaRefusals) return 'Reapplication';
  return 'First-time';
}

// Build "why approve" rationale cues from facts
function buildRationalePoints(p, appType) {
  const cues = [];

  // Funds / affordability
  const bal = parseNum(p.currentBankBalance);
  const trip = parseNum(p.estimatedTripCost);
  if (Number.isFinite(bal) && Number.isFinite(trip) && trip > 0) {
    const margin = bal - trip;
    if (margin >= 0) cues.push(`Funds cover the estimated trip cost with a remaining balance of about ${margin.toLocaleString()}.`);
  } else if (Number.isFinite(bal)) {
    cues.push(`Bank balance indicates capacity to fund the trip.`);
  }

  // Income stability
  if (p.income) cues.push(`Stable monthly income declared: ${p.income}.`);

  // Sponsor / Family / Employer
  if (p.funding) {
    if ((p.funding || '').toLowerCase() === 'employer') {
      if (p.employerName || p.employerAddress) cues.push(`Employer support documented (${p.employerName || 'employer'}), including travel cost coverage where stated.`);
    } else if ((p.funding || '').toLowerCase() === 'family') {
      if (p.sponsorName || p.sponsorRelationship) cues.push(`Family sponsorship declared by ${p.sponsorName || 'family member'} (${p.sponsorRelationship || 'relationship stated'}), with supporting documents.`);
    } else if ((p.funding || '').toLowerCase() === 'sponsor') {
      if (p.sponsorName) cues.push(`Third-party sponsorship by ${p.sponsorName}${p.sponsorRelationship ? ` (${p.sponsorRelationship})` : ''}, with financial evidence provided.`);
    }
  }

  // Accommodation / Invitation
  if (p.stayDetails) cues.push(`Accommodation/host details provided (${p.stayDetails.slice(0, 80)}…).`);
  if (p.invited && String(p.invited).toLowerCase() === 'yes') cues.push(`Invitation and host supporting documents attached.`);

  // Ties to Nigeria
  const ties = [];
  if (p.propertyDetails) ties.push('property ownership');
  if (p.businessCommitments || p.employerName) ties.push('ongoing employment/business');
  if (p.familyDependents) ties.push('family dependents');
  if (ties.length) cues.push(`Strong ties to Nigeria: ${ties.join(', ')}.`);

  // History / Compliance
  if (p.validVisas || p.travelHistory) cues.push(`Prior travel/visa history demonstrates compliance with immigration rules.`);

  // Reapplication-specific
  if (appType === 'Reapplication') {
    if (p.visaRefusals) cues.push(`This submission provides new/clearer evidence addressing the refusal points.`);
    if (p.significantTransactions) cues.push(`Large/irregular transactions are explained in context.`);
    if (p.bankStatementDetails) cues.push(`Bank statement trend and details are clarified.`);
    if (p.sponsorDocs) cues.push(`Sponsor documentation is included to close prior gaps.`);
  }

  // Study/Medical empathy
  if ((p.visaType || '').toLowerCase() === 'study') {
    cues.push('The study period is time-bound and purpose-specific, with a clear plan to return to Nigeria.');
  }
  if ((p.visaType || '').toLowerCase() === 'medical') {
    cues.push('Medical timeline and funding are defined, with intention to return after treatment.');
  }

  // Trim + cap lines
  return cues.slice(0, 8);
}

// ---------- Prompt Builder (SOP-aware, empathetic) ----------
function buildMessages(detailLines, payload) {
  const joined = detailLines.join('\n');

  // Extract some fields to steer structure
  const getField = (label) => {
    const m = new RegExp('^' + label.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&') + '\\s*:\\s*(.+)$', 'mi').exec(joined);
    return m ? m[1].trim() : undefined;
  };
  const destination = getField('Destination') || getField('Destination Country') || '[Destination]';
  const visaType = getField('Visa Type') || 'Visitor';
  const purpose = getField('Purpose of Travel') || '';

  const refusalPresent =
    /(^|\n)\s*(Visa Refusals|Previous Visa Refusals)\s*:/i.test(joined) ||
    /\brefusal(s)?\b/i.test(purpose);

  const appType = detectApplicationType(payload);
  const sponsored = isSponsoredPayload(payload);
  const selfEmployed = /(^|\n)\s*Occupation:\s*(owner|self|founder|ceo|proprietor)/i.test(joined) ||
                       /(^|\n)\s*Employment Status:\s*Self-employed/i.test(joined);

  const isMedical = /(^|\n)\s*Medical:/i.test(joined) || /(^|\n)\s*Visa Type:\s*Medical/i.test(joined);
  const isBusiness= /(^|\n)\s*Visa Type:\s*Business/i.test(joined);
  const isTourist = /(^|\n)\s*Visa Type:\s*Tourist/i.test(joined);

  const hasWeaknesses = /(^|\n)\s*Potential Weaknesses:\s*\S+/i.test(joined);

  // tone selection
  const tone =
    isMedical || hasWeaknesses ? 'Warm, empathetic and respectful, but concise and professional.' :
    (isTourist || /Visit/i.test(visaType) || /Study/i.test(visaType)) ? 'Courteous, positive, and professional.' :
    'Formal, direct, and professional.';

  // Scenario hints + minis
  const blocks = [];
  const hints = [];
  if (refusalPresent || appType === 'Reapplication') {
    hints.push('Reapplication after refusal: provide a brief, factual clarification to each refusal point and show new evidence.');
    const t = getMini('refusal');
    if (t) blocks.push('--- MINI (Reapplication) ---\n' + t);
  }
  if (sponsored) {
    hints.push('Sponsored: identify sponsor, relationship, income, accommodation support, and list sponsor documents clearly.');
    const t = getMini('sponsor');
    if (t) blocks.push('--- MINI (Sponsor) ---\n' + t);
  }
  if (selfEmployed) {
    hints.push('Self-employed: reference business registration (CAC), tax returns, and invoices where provided.');
    const t = getMini('self_employed');
    if (t) blocks.push('--- MINI (Self-employed) ---\n' + t);
  }
  if (isMedical) {
    const t = getMini('medical');
    if (t) blocks.push('--- MINI (Medical) ---\n' + t);
  }
  if (isBusiness) {
    const t = getMini('business');
    if (t) blocks.push('--- MINI (Business/Conference) ---\n' + t);
  }
  if (isTourist && !/Travel History:\s*\S+/i.test(joined)) {
    const t = getMini('tourist');
    if (t) blocks.push('--- MINI (Tourist First-time) ---\n' + t);
  }

  // currency policy
  const currencyPolicy = `When formatting amounts with no symbol, default to ₦ (Naira). If a symbol or currency word is already present (e.g., £, USD), keep exactly what was provided—do not convert.`;

  // Build rationale cues
  const rationalePoints = buildRationalePoints(payload, appType);
  const rationaleBlock = rationalePoints.length
    ? `\n--- APPROVAL RATIONALE CUES ---\n${rationalePoints.map(x => '- ' + x).join('\n')}\n`
    : '\n--- APPROVAL RATIONALE CUES ---\n(no explicit cues; infer from facts above)\n';

  const systemMessage = {
    role: 'system',
    content:
      `You are an expert consular assistant for visa cover letters.\n` +
      `Write embassy-acceptable letters using the following tone: ${tone}\n` +
      `Paragraphs should be short and clear. Never invent facts. Be specific but concise.\n` +
      `${currencyPolicy}\n` +
      `Synthesize style from samples without copying any sentence verbatim.\n`
  };

  const guide = {
    role: 'user',
    content:
`STRUCTURE (Plain text only):
1) Applicant contact (if provided) + current date (Nigeria date format acceptable)
2) Embassy block (if provided)
3) Subject: "Application for ${visaType} Visa to ${destination}"
4) Salutation
5) Body:
   - Identity & travel dates
   - Employment/Business & income (note if self-employed or student)
   - Funding & accommodation (if sponsor/family/employer, spell it out)
   - If reapplication: short clarification addressing refusal
   - Supporting documents referenced (only those user mentioned)
   - Strong ties to Nigeria & clear return assurance
   - ${appType === 'Reapplication'
        ? 'Include a short paragraph titled "Why my application merits approval now", summarising what has changed since refusal and how new evidence addresses concerns.'
        : 'Include a short paragraph titled "Why my application merits approval", clearly stating the strengths of the case.'}
   (Avoid bullet lists in the final letter—write it as cohesive prose.)
6) Closing: "Sincerely," + full name

--- MASTER RULES ---
${clip(SOP.masterRules, 3000)}

--- STRUCTURE GUIDE ---
${clip(SOP.structureGuide, 1800)}

--- QUALITY CHECKLIST ---
${clip(SOP.qualityChecklist, 1200)}

--- MASTER TEMPLATE (reference; adapt, never copy) ---
${clip(SOP.masterTemplate, 2500)}

--- STYLE DIGEST (sample excerpts) ---
${STYLE_DIGEST || '(no samples? but server would have refused to start)'}
${blocks.length ? '\n\n' + blocks.join('\n\n') : ''}
${rationaleBlock}

--- SCENARIO HINTS ---
${hints.length ? '- ' + hints.join('\n- ') : '(none)'}
`
  };

  const userInstruction = {
    role: 'user',
    content:
`Use ONLY these facts (omit fields not provided). Do not hallucinate.

${detailLines.map(l => '- ' + l).join('\n')}

OUTPUT:
Return a single cohesive plain-text cover letter.`
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
        // max_completion_tokens: 900, // optional
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

// ------------------------ Health ------------------------
app.get('/', (_req, res) => res.send('✅ Visa Letter API (SOP-STRICT + Rationale) is running'));
app.get('/health', (_req, res) => res.json({ ok: true, model: MODEL_NAME }));

// ------------------------ Main Endpoint ------------------------
app.post('/generate-letter', async (req, res) => {
  try {
    const b = req.body || {};

    const payload = {
      // Optional explicit app type (frontend may or may not send this)
      applicationType: clean(b.applicationType),

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

      // Branding / consular
      accommodation: clean(b.accommodation),
      documents: clean(b.documents),
      embassyName: clean(b.embassyName),
      embassyAddress: clean(b.embassyAddress),
      companyName: clean(b.companyName) || 'No Guide Travel Agent',
    };

    // Required core fields
    const required = ['name', 'age', 'nationality', 'destination', 'visaType', 'purpose', 'income'];
    const missing = required.filter((k) => !payload[k]);

    // Sponsor sanity: if sponsored intent but key fields missing
    if (isSponsoredPayload({ ...payload })) {
      if (!payload.sponsorName) missing.push('sponsorName (required when funding involves a sponsor/family/employer)');
      if (!payload.sponsorRelationship) missing.push('sponsorRelationship (required when funding involves a sponsor/family)');
    }
    if (missing.length) {
      return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    }

    // Build detail lines for the prompt
    const d = [];
    const appType = detectApplicationType(payload);
    d.push(`Application Type: ${appType}`);

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
    if (payload.invited) d.push(`Invited by someone?: ${payload.invited}`);
    if (payload.inviterName) d.push(`Inviter Name: ${payload.inviterName}`);
    if (payload.inviterAddress) d.push(`Inviter Address: ${payload.inviterAddress}`);
    if (payload.inviterRelationship) d.push(`Inviter Relationship: ${payload.inviterRelationship}`);
    if (payload.inviterDocs) d.push(`Inviter Documents: ${payload.inviterDocs}`);
    if (payload.stayDetails) d.push(`Accommodation/Host Details: ${payload.stayDetails}`);
    if (payload.travelItinerary) d.push(`Travel Itinerary: ${payload.travelItinerary}`);

    if (payload.occupation) d.push(`Occupation: ${payload.occupation}`);
    if (payload.employerName) d.push(`Employer/Business Name: ${payload.employerName}`);
    if (payload.employerAddress) d.push(`Employer/Business Address: ${payload.employerAddress}`);
    if (payload.employmentDuration) d.push(`Employment Duration: ${payload.employmentDuration}`);
    d.push(`Monthly Income: ${payload.income}`);
    if (payload.otherIncome) d.push(`Other Income: ${payload.otherIncome}`);
    if (payload.funding) d.push(`Funding Source: ${payload.funding}`);
    if (payload.bankStatementDetails) d.push(`Bank Statement Details: ${payload.bankStatementDetails}`);
    if (payload.significantTransactions) d.push(`Significant Transactions: ${payload.significantTransactions}`);
    if (payload.monthlyExpenses) d.push(`Monthly Expenses: ${payload.monthlyExpenses}`);
    if (payload.currentBankBalance) d.push(`Current Bank Balance: ${payload.currentBankBalance}`);
    if (payload.estimatedTripCost) d.push(`Estimated Trip Cost: ${payload.estimatedTripCost}`);

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

    if (payload.specialEvents) d.push(`Special Events/Extras: ${payload.specialEvents}`);
    if (payload.compellingReasons) d.push(`Compelling Reasons: ${payload.compellingReasons}`);
    if (payload.supportingLetters) d.push(`Supporting Letters/Docs: ${payload.supportingLetters}`);
    if (payload.potentialWeaknesses) d.push(`Potential Weaknesses: ${payload.potentialWeaknesses}`);

    d.push(`Company: ${payload.companyName}`);
    if (payload.embassyName) d.push(`Embassy Name: ${payload.embassyName}`);
    if (payload.embassyAddress) d.push(`Embassy Address: ${payload.embassyAddress}`);

    const messages = buildMessages(d, payload);
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
  console.log(`✅ Visa Letter API (SOP-STRICT + Rationale) listening on http://localhost:${PORT}`);
});
