import { addDebugLog, traceCapture } from './settings.js';
import { wordTokens } from './tokenize.js';
import * as host from './host.js';

const DB_PREFIX = 'bf_memory_db_';

// ===========================================================================
// PREMISE FLOOR CAP — a user setting, not a constant.
//
// This lives HERE rather than in agent-memory.js (where it was, and from where
// it is still re-exported so every existing importer keeps working) for one
// reason: coldTierOverflow() below has to know it. It is a synchronous function
// on the save path, so a dynamic import is not available to it, and a
// hand-copied second constant is exactly the stale-copy trap this file's other
// derived caps are written to avoid.
//
// SETTINGS CONTRACT (the settings UI binds to these exports; nothing else reads
// the raw key):
//   settings.premiseFloorMax
//     1 .. 100  -> that many premise-floor rows per sheet
//     0         -> PREMISE_FLOOR_UNLIMITED: every eligible fact, no cap at all
//     absent / not a number -> PREMISE_FLOOR_DEFAULT
export const PREMISE_FLOOR_SETTING_KEY = 'premiseFloorMax';
export const PREMISE_FLOOR_UNLIMITED = 0;
export const PREMISE_FLOOR_MIN = 1;
export const PREMISE_FLOOR_SLIDER_MAX = 100;
// 30, down from 50: 50 was sized for a 65-fact store (see the coverage curve at
// selectPremiseFloor in agent-memory.js) and on the 469-fact 0.83.0 long runs
// it filled 47-51 CURRENT STATE rows every turn. The floor is now also under a
// per-section char budget (recency.js SHEET_BUDGET_*), which is what bounds
// the sheet; the row cap just decides how many rows the budget chooses among.
export const PREMISE_FLOOR_DEFAULT = 30;

// Resolves the setting to a usable cap. `cap` is Infinity when unlimited, so
// every consumer can do arithmetic with it without special-casing the sentinel;
// `unlimited` is there for callers that must render or log the distinction.
//
// TYPE CHECK BEFORE COERCION, and it is load-bearing. `Number()` answers 0 for
// `false`, for `''` and for `[]` — and 0 is the UNLIMITED sentinel, i.e. the
// single most expensive position this setting has. A corrupt or hand-edited
// settings entry must not resolve to "put the entire store on every prompt".
// Only a number, or a string that is entirely a number, is a value here;
// everything else is "not set" and takes the default.
//
// ±Infinity, by contrast, IS a number and the intent behind it is legible
// ("as many as possible" / "as few as possible"), so it CLAMPS like any other
// out-of-range number rather than falling back to the default. That
// distinction matters because only the clamp path reports source 'clamped',
// which is what settings.js logs a warning on — a silent default would leave
// the user's file saying one thing and the extension doing another.
export function resolvePremiseFloorCap(settings) {
    const raw = settings?.[PREMISE_FLOOR_SETTING_KEY];
    const numeric = typeof raw === 'number'
        || (typeof raw === 'string' && raw.trim() !== '' && !Number.isNaN(Number(raw)));
    const n = numeric ? Number(raw) : NaN;
    if (!numeric || Number.isNaN(n)) {
        return { cap: PREMISE_FLOOR_DEFAULT, unlimited: false, raw, source: 'default' };
    }
    const t = Math.trunc(n);
    if (t === PREMISE_FLOOR_UNLIMITED) {
        return { cap: Infinity, unlimited: true, raw, source: 'setting' };
    }
    // Math.trunc(Infinity) is Infinity, which Math.min/Math.max clamp correctly.
    const cap = Math.min(PREMISE_FLOOR_SLIDER_MAX, Math.max(PREMISE_FLOOR_MIN, t));
    return { cap, unlimited: false, raw, source: cap === t ? 'setting' : 'clamped' };
}

// ===========================================================================
// THE HOT-SET BUDGET — how many demotable rows a category may keep before
// coldTierOverflow() demotes the tail.
//
// This used to be the flat constant 50, and that constant was a SECOND, HIDDEN
// CAP sitting underneath the premise-floor slider. Cold facts are skipped by
// selectPremiseFloor(), by composeSheet()'s ref resolution and by the
// reflection digest, so 50 demotable rows per category x 7 categories was a
// hard ceiling of ~350 sheet-eligible rows no matter where the slider stood —
// including UNLIMITED, where "unlimited" was therefore false. Above ~350 facts
// the user's stated coverage goal was unreachable by construction, and the cost
// readout could not see it either.
//
// WHAT COLD-TIERING IS ACTUALLY FOR decides the fix. It does two jobs:
//   (a) it is a VERDICT — a #CONFLICT loser, a merge loser, a reflection
//       demotion. markFactCold() is that path and it is untouched here.
//   (b) it is a BUDGET — "this category's tail is crowding the sheet".
// Job (b) is now the slider's job, explicitly, with a number in front of the
// user. Two budgets for one thing, where the lower one is invisible and wins,
// is the defect. So the budget follows the setting:
//
//   finite cap C -> max(HOT_SET_MIN, C) demotable rows per category. The cap is
//       a GLOBAL row budget, so even a sheet drawn entirely from one category
//       cannot want more than C rows from it — at C the cold tier can never be
//       the binding constraint, and HOT_SET_MIN keeps the historical 50 for
//       every cap below it.
//   UNLIMITED -> Infinity, i.e. the overflow demotion does not fire at all.
//
// WHAT THAT TRADES. Under UNLIMITED nothing automatically bounds the working
// set any more; `cold` narrows to meaning (a) only, and the store's whole
// low-salience tail stays on every sheet. That is the token bill the user
// accepted, and estimatePremiseFloorCost() is what states it. The cost that is
// NOT tokens: salience stops being coarsely pre-sorted for the retrieval
// ranking, which now has to discriminate on the raw score — which is exactly
// why the lastUsedAt ratchet below had to be fixed in the same pass. Selection
// cost is not part of the trade: selectPremiseFloor is 6 ms over 4 000 facts.
//
// REVERSIBILITY IS FREE and needs no new field. Raising the cap (or switching
// to UNLIMITED) makes `demotable.length <= budget` true again, and that branch
// already un-colds every demoted row in the category. Lowering it re-demotes on
// the next write. reconcileColdTier() below is what applies a slider change to
// categories that are not otherwise written.
const HOT_SET_MIN = 50;

function hotSetBudget() {
    let settings = null;
    try { settings = host.getExtensionSettings(); } catch { settings = null; }
    const { cap, unlimited } = resolvePremiseFloorCap(settings);
    if (unlimited) return Infinity;
    return Math.max(HOT_SET_MIN, cap);
}

const COLD_TIER_PROTECT_IMPORTANCE = 5;

const DEFAULT_IMPORTANCE = 3;
const DEFAULT_KIND = 'trait';

const VALID_KINDS = new Set(['trait', 'state', 'event', 'moment']);

const IMPORTANCE_WEIGHT = 0.65;
const RECENCY_WEIGHT = 0.35;

const HALF_LIFE_DAYS = { trait: 90, state: 3, event: 7, moment: 30 };

const USE_BONUS_WEIGHT = 0.06;
const USE_BONUS_CAP = 0.20;

const COLD_BASE = -0.10;  
const COLD_SPAN = 0.80;   

export function useBonus(useCount) {
    const n = Number(useCount);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(USE_BONUS_CAP, USE_BONUS_WEIGHT * Math.log1p(n));
}

export function effectiveRecencyTs(fact) {
    const upd = Number(fact?.lastUpdated) || 0;
    const used = Number(fact?.lastUsedAt) || 0;
    return Math.max(upd, used);
}

export function clampImportance(v) {

    const n = (v === null || v === undefined || v === '') ? NaN : Math.round(Number(v));
    if (!Number.isFinite(n)) return DEFAULT_IMPORTANCE;
    return Math.min(5, Math.max(1, n));
}

export function normalizeKind(v) {
    const k = String(v || '').trim().toLowerCase();
    return VALID_KINDS.has(k) ? k : DEFAULT_KIND;
}

// `kind` is load-bearing, not decoration. Two whole maintenance mechanisms select
// on it and nothing else: REEVAL only re-examines kind === 'state', CALLBACK only
// surfaces kind === 'moment'. In the analysed 36-message run the store came out
// {trait:61, state:2, event:1, moment:0} — including Events/naoto_sealed_in_pod
// filed as a trait — so both mechanisms ran against an empty candidate set and
// fired zero times. 'trait' is the model's safe answer under uncertainty, and a
// safe answer does not move under prompt pressure. So the kind is DERIVED from the
// two fields the model does get right (owning category and aspect) wherever the
// mapping is unambiguous, and the model's own answer is consulted only for the
// aspects that could honestly go either way.
//
// Neither set may contain a DEFAULT_ASPECT value ('status', 'feature', 'object',
// 'history', 'scene', 'lore', 'misc'): those are the sinks normalizeAspect() drops
// an UNRECOGNISED aspect into, so a fact sits there because nothing could classify
// it, not because it is a state. Deriving off a sink would mislabel the tail of the
// store wholesale.
//
// THE EFFECT THAT IS NOT ABOUT REEVAL/CALLBACK, and it is the larger one: `kind` is
// the direct index into HALF_LIFE_DAYS above, so it also sets the recency decay used
// by salienceScore() — and salienceScore() is what coldTierOverflow() ranks on. A
// row re-derived from 'trait' to 'state' drops from a 90-day half-life to 3 days.
// With IMPORTANCE_WEIGHT 0.65 / RECENCY_WEIGHT 0.35, an importance-3 row last touched
// 21 days ago falls from 0.39 + 0.35·0.5^(21/90) ≈ 0.69 to 0.39 + 0.35·0.5^(21/3) ≈ 0.39,
// and useBonus() caps at 0.20, so no amount of use makes that back up. Cold rows are
// excluded from the reflection digest, the premise floor and the sheet, so a wrong
// derivation here does not merely fail to recheck a fact — it can retire it. Two things bound that: COLD_TIER_PROTECT_IMPORTANCE
// exempts importance 5 outright, and nothing goes cold at all until a category holds
// more demotable rows than hotSetBudget() allows — which under UNLIMITED is never.
// Membership in STATE_ASPECTS is therefore a
// claim about DECAY as much as about rechecking: put an aspect there only if a
// three-day-old answer is genuinely suspect.

// One-off felt beats — something that HAPPENED between people and left a mark.
// This is what CALLBACK is for: a thread the storyteller can pick back up.
const MOMENT_ASPECTS = new Set([
    // People > Origin & Past / Fears & Wounds
    'formative_event', 'trauma', 'first_love', 'worst_day', 'defining_loss',
    'turning_point_past', 'coming_of_age', 'early_hardship',
    'grief', 'emotional_wound', 'past_hurt', 'unresolved_pain', 'sore_spot', 'nightmare',
    // Relationships > Origin / Romance / Conflict / Trust & Standing / Dynamics
    'how_they_met', 'first_impression', 'origin_of_bond', 'turning_point', 'introduction',
    'heartbreak', 'breakup', 'engagement', 'infidelity',
    'betrayal', 'falling_out',
    'reconciliation', 'forgiveness', 'disappointment',
    'last_interaction',
]);

// Things that are true NOW and can stop being true WITHIN A SCENE OR TWO — what
// REEVAL exists to recheck, and what a three-day half-life is an honest model of.
// The binding case from the analysed run lives here: 'disguise' / 'state_of_dress'
// went stale under a "CURRENT STATE — absolute truth" header for 14 of 15 turns
// because nothing ever put those facts in front of a recheck.
//
// Deliberately NOT here, though every one of them is technically mutable:
// 'career', 'vocation', 'employer', 'workplace', 'commute', 'legal_status',
// 'mental_health'. These change on the scale of a story arc, not a scene, and they
// are premise identity — the state-recheck ranking rationale in agent-memory.js
// names 'career' as its example of a top-importance field that by construction does
// not move. Filing them as 'state' would have contradicted that comment AND cut
// their half-life to three days, which retires a character's job from the sheet
// faster than their mood. A career change is a #CONFLICT or an explicit SUPERSEDE,
// which both work without REEVAL candidacy.
const STATE_ASPECTS = new Set([
    // People > Daily Life — where they are and what they are doing right now
    'current_location', 'current_activity', 'companions_present', 'errands',
    // People > Health — injuries and everything that heals
    'health', 'injuries', 'illness', 'pain', 'fatigue', 'recovery', 'convalescence',
    'medication', 'pregnancy', 'symptom', 'sleep_quality',
    // People > Mind — the mood that persists past the scene
    'mood',
    // People > Appearance Style — what is on the body right now
    'current_clothing', 'state_of_dress', 'disguise', 'worn_items',
    // People > Drives — the goal in play
    'current_goal', 'short_term_goal',
    // Places
    'place_status', 'condition', 'damage', 'current_use', 'under_construction',
    'contamination', 'weather', 'crowd',
    // Things
    'condition_of_item', 'location_of_item', 'ownership', 'charge_remaining',
    'lost_status', 'malfunction', 'weapon_condition',
    // Relationships
    'status_of_relationship', 'distance',
    // World > Calendar / Clock / Reckoning / Threats — the clock and the live crisis
    'time_of_day', 'hour', 'date', 'season', 'elapsed_time', 'duration', 'countdown',
    'scarcity', 'conflict_world', 'looming_danger', 'invasion', 'famine', 'plague', 'rebellion',
]);

/**
 * Decide a fact's `kind` from what it demonstrably is, falling back to the agent.
 * @param {object} fact          The incoming fact.
 * @param {string} [owningCategory] Category of the db it is being written into;
 *                               authoritative when the fact carries none.
 * @returns {{kind: string, via: string}} `via` names the rule that decided, so the
 *          caller can log an override without re-deriving it.
 */
export function deriveKind(fact, owningCategory) {
    const category = fact?.category || owningCategory;

    // A track step is a beat on a timeline by construction — deriveScope() already
    // asserts exactly this for the same predicate.
    if (isSequenceFact(fact)) return { kind: 'event', via: 'SEQUENCE_STEP' };

    if (String(mapLegacyCategory(category, fact)).toLowerCase() === 'events') {
        return { kind: 'event', via: 'CATEGORY_EVENTS' };
    }

    const aspect = normalizeAspect(fact?.aspect, category);
    if (MOMENT_ASPECTS.has(aspect)) return { kind: 'moment', via: 'ASPECT_MOMENT' };
    if (STATE_ASPECTS.has(aspect)) return { kind: 'state', via: 'ASPECT_STATE' };

    const passed = passedKindOf(fact);
    if (passed) return { kind: passed, via: 'AGENT' };
    return { kind: DEFAULT_KIND, via: 'DEFAULT' };
}

// "Did the caller actually say a kind" — distinct from normalizeKind(), which
// answers 'trait' for undefined just as readily as for garbage.
function passedKindOf(fact) {
    if (!fact || fact.kind === undefined || fact.kind === null) return '';
    if (!String(fact.kind).trim()) return '';
    return normalizeKind(fact.kind);
}

const TONE_MAX_LEN = 40;

function normalizeTone(v) {
    const t = String(v ?? '').replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, TONE_MAX_LEN) : '';
}

export const L1_CATEGORIES = ['People', 'Places', 'Things', 'Relationships', 'Events', 'World', 'Unsorted'];

const TAXONOMY = {
    People: {

        'Identity': [
            'status', 'identity', 'name', 'aliases', 'age', 'birthdate', 'species', 'gender',
            'pronouns', 'ethnicity', 'nationality', 'titles', 'legal_status', 'naming_origin',
            'identity_secret', 'self_concept', 'public_persona', 'private_persona', 'caste',
            'birth_name', 'middle_name', 'surname', 'epithet', 'codename', 'true_name',
            'apparent_age', 'maturity', 'citizenship', 'documentation',
        ],
        'Origin & Past': [
            'origin', 'childhood', 'birthplace', 'family_origin', 'upbringing', 'education',
            'formative_event', 'trauma', 'lost_home', 'prior_career', 'coming_of_age',
            'first_love', 'worst_day', 'ancestry', 'bloodline', 'lineage', 'inherited_status',
            'defining_loss', 'lineage_secret', 'hometown', 'social_origin', 'mentor_past',
            'apprenticeship', 'military_service', 'past_residence', 'early_hardship',
            'turning_point_past', 'past_alias',
        ],

        'Body': [
            'appearance', 'height', 'build', 'weight', 'skin', 'hair', 'eyes', 'face', 'hands',
            'posture', 'gait', 'voice', 'voice_timbre', 'scent', 'complexion',
            'distinguishing_feature', 'physiology_quirk', 'nonhuman_traits',
            'hair_color', 'eye_color', 'skin_tone', 'figure', 'musculature', 'frame',
            'facial_hair', 'teeth', 'nails', 'feet', 'fingers', 'physical_age_signs',
            'handedness',
        ],
        'Marks & Modifications': [
            'body_marks', 'scars', 'tattoos', 'birthmarks', 'piercings', 'brands', 'prosthetics',
            'cybernetics', 'ritual_marks', 'disfigurement', 'freckles', 'moles', 'bruises',
            'calluses', 'implants', 'augmentations',
        ],
        'Appearance Style': [
            'wardrobe', 'current_clothing', 'grooming', 'jewelry', 'makeup', 'fragrance',
            'signature_look', 'uniform', 'armor_worn', 'accessories', 'disguise', 'state_of_dress',
            'footwear', 'headwear', 'hairstyle', 'color_palette', 'cleanliness_personal',
            'fashion_sense', 'worn_items',
        ],
        'Health': [
            'health', 'injuries', 'illness', 'chronic_condition', 'allergies', 'disability',
            'addiction_physical', 'fitness', 'fertility', 'pregnancy', 'medication',
            'mental_health', 'sleep_quality', 'pain', 'fatigue', 'recovery',
            'diagnosis', 'symptom', 'immunity', 'vision', 'hearing', 'metabolism',
            'physical_limit', 'scarring_internal', 'convalescence',
        ],

        'Mind & Personality': [
            'mood', 'temperament', 'demeanor', 'intelligence_style', 'humor', 'patience',
            'confidence', 'neuroticism', 'openness', 'optimism', 'quirks', 'core_trait', 'flaw',
            'virtue', 'temper', 'introversion_extroversion', 'stress_response',
            'disposition', 'self_esteem', 'empathy', 'wit', 'curiosity', 'discipline',
            'impulsiveness', 'pessimism', 'attitude', 'demeanor_under_pressure',
        ],
        'Beliefs & Values': [
            'beliefs', 'values', 'morals', 'religion', 'ideology', 'superstitions',
            'code_of_honor', 'taboos', 'political_view', 'loyalty_object', 'worldview',
            'sacred_values', 'principle', 'conviction', 'prejudice', 'faith_personal',
            'moral_line', 'philosophy', 'stance',
        ],
        'Drives': [
            'desires', 'ambitions', 'current_goal', 'motivation', 'dreams', 'regrets', 'guilt',
            'shame', 'pride', 'what_they_protect', 'unmet_need', 'temptation', 'guilty_pleasure',
            'aspiration', 'long_term_goal', 'short_term_goal', 'hope', 'wish', 'craving',
            'driving_question', 'purpose_personal',
        ],
        'Fears & Wounds': [
            'fears', 'insecurities', 'emotional_wound', 'triggers', 'grief', 'anxieties',
            'dread_object', 'existential_fear', 'social_fear', 'nightmare', 'sore_spot',
            'vulnerability', 'past_hurt', 'unresolved_pain', 'doubt',
        ],
        'Sexuality': [
            'sexuality', 'orientation', 'attractions', 'turn_ons', 'turn_offs', 'kinks',
            'boundaries', 'experience_level', 'libido', 'romantic_style', 'intimacy_style',
            'attraction_pattern', 'consent_style', 'fantasy', 'inhibition', 'comfort_zone',
        ],

        'Behavior': [
            'habits', 'tells', 'mannerisms', 'speech_style', 'catchphrases', 'rituals',
            'coping_mechanism', 'social_mask', 'body_language', 'compulsion',
            'nervous_tell', 'gesture_habit', 'verbal_tic', 'idiosyncrasy', 'reaction_pattern',
            'social_behavior', 'eating_habit', 'sleep_habit',
        ],
        'Vices & Struggles': [
            'vices', 'drinking', 'smoking', 'addiction_behavioral', 'bad_habit',
            'self_destructive_pattern', 'gambling', 'indulgence', 'weakness_personal',
            'guilty_habit', 'dependency_personal',
        ],
        'Secrets': [
            'secrets', 'hidden_agenda', 'lies_told', 'double_life', 'concealed_identity',
            'buried_past', 'guilty_knowledge', 'cover_story', 'blackmail_material',
            'secret_shame', 'undisclosed_motive', 'kept_promise', 'withheld_truth',
        ],

        'Capabilities': [
            'skills', 'talents', 'languages', 'combat_skill', 'magic_ability', 'profession_skill',
            'tech_skill', 'social_skill', 'craft', 'weakness', 'limitation', 'training',
            'incompetence', 'specialty', 'signature_move', 'proficiency', 'instinct',
            'physical_ability', 'mental_ability', 'survival_skill', 'artistic_skill',
        ],
        'Knowledge': [
            'knowledge', 'field_of_expertise', 'secret_knowledge', 'forbidden_knowledge', 'trivia',
            'street_smarts', 'lore_known', 'expertise', 'education_subject', 'rumor_known',
            'information_held', 'witnessed_event',
        ],

        'Status & Standing': [
            'reputation', 'social_class', 'rank', 'wealth_level', 'fame', 'infamy',
            'criminal_record', 'honors', 'notoriety', 'public_opinion', 'standing', 'prestige',
            'disgrace', 'legacy', 'influence',
        ],
        'Resources': [
            'finances', 'income', 'debts', 'property_owned', 'assets', 'possessions_notable',
            'dependents', 'employer', 'patron', 'savings', 'inheritance', 'liabilities',
            'business_owned', 'sponsor',
        ],
        'Affiliation': [
            'allegiance', 'membership', 'oath_sworn', 'rank_in_group', 'defected_from',
            'loyalty_target', 'faction_membership', 'sworn_enemy', 'sworn_ally', 'patronage',
            'guild_membership',
        ],

        'Daily Life': [
            'career', 'vocation', 'daily_routine', 'home', 'current_location',
            'residence_type', 'transport', 'carried_items', 'pets', 'schedule', 'hobbies', 'diet',
            'current_activity', 'workplace', 'commute', 'errands', 'leisure', 'companions_present',
        ],
    },
    Places: {
        'Identity': ['place_type', 'place_name', 'owner', 'founding', 'place_naming_origin', 'place_aliases', 'place_status'],
        'Layout': ['feature', 'rooms', 'entrances', 'architecture', 'scale', 'layout_secret', 'hidden_area', 'decor', 'furnishings', 'floor_plan', 'levels', 'exits', 'notable_object_in_place'],
        'Function': ['function', 'purpose', 'services', 'capacity', 'current_use', 'former_use', 'amenities', 'operating_hours'],
        'Atmosphere': ['atmosphere', 'lighting', 'sounds', 'smells', 'mood_of_place', 'cleanliness', 'temperature', 'ambiance', 'vibe'],
        'Access & Security': ['access', 'defenses', 'guards', 'locks', 'hazards', 'hidden_entrance', 'restrictions', 'surveillance', 'entry', 'wards', 'traps', 'patrols'],
        'Inhabitants': ['inhabitants', 'population', 'factions_present', 'notable_resident', 'wildlife', 'staff', 'regulars', 'crowd', 'ruler_of_place'],
        'Condition': ['condition', 'damage', 'age_of_place', 'upkeep', 'ruin_state', 'abandonment', 'under_construction', 'contamination'],
        'Environment': ['geography', 'climate', 'terrain', 'resources_local', 'flora', 'fauna', 'weather', 'natural_feature', 'water_source'],
        'Significance': ['significance', 'history_of_place', 'events_here', 'sacred_status', 'strategic_value', 'reputation_of_place', 'sentimental_value', 'legend_of_place'],
        'Position': ['location', 'neighbors', 'region', 'distance', 'travel_routes', 'jurisdiction', 'borders_place', 'accessibility', 'isolation'],
    },
    Things: {
        'Identity': ['object', 'item_name', 'item_type', 'make', 'origin_of_item', 'model', 'brand', 'item_aliases'],
        'Key Items': ['key_item', 'plot_object', 'macguffin', 'heirloom', 'gift', 'stolen_item', 'evidence', 'quest_item', 'token', 'keepsake'],
        'Physical': ['properties', 'material', 'size', 'color', 'appearance_of_item', 'age_of_item', 'weight_of_item', 'shape', 'texture', 'markings_on_item'],
        'Weapons': ['weapon', 'firearm', 'blade', 'ammunition', 'range', 'weapon_condition', 'armor_item', 'explosive', 'shield', 'damage_type', 'reach'],
        'Tech & Tools': ['tech', 'gadget', 'vehicle', 'device', 'machine', 'tool', 'software', 'controls', 'instrument', 'apparatus', 'power_source', 'interface'],
        'Substances': ['substance', 'drug', 'poison', 'medicine', 'food', 'drink', 'fuel', 'reagent', 'potion', 'chemical', 'sample', 'ration'],
        'Magic & Special': ['enchantment', 'artifact', 'power', 'curse', 'charge_remaining', 'activation', 'special_property', 'relic', 'sigil', 'bound_spirit', 'attunement'],
        'Function': ['use', 'capability', 'malfunction', 'requirement', 'side_effect', 'operation', 'maintenance', 'compatibility'],
        'Provenance': ['ownership', 'previous_owner', 'acquisition', 'location_of_item', 'hidden_location', 'claim_disputed', 'maker', 'lost_status'],
        'Value': ['currency', 'worth', 'rarity', 'market_value', 'sentimental_worth', 'condition_of_item', 'demand', 'legality'],
        'Documents': ['document', 'letter', 'map', 'record', 'contract', 'book', 'message', 'photograph', 'note', 'ledger', 'inscription', 'recording'],
    },
    Relationships: {

        'Origin': ['history', 'how_they_met', 'first_impression', 'origin_of_bond', 'turning_point', 'shared_history', 'introduction'],
        'Family': ['family_ties', 'parent_child', 'siblings', 'marriage', 'kinship', 'guardianship', 'estrangement', 'adoption', 'extended_kin', 'spousal', 'in_laws', 'ancestral_tie'],
        'Bonds': ['friendship', 'companionship', 'mentorship', 'partnership', 'acquaintance', 'found_family', 'camaraderie', 'fellowship', 'bond_strength'],
        'Romance': ['romance', 'attraction', 'courtship', 'intimacy', 'commitment', 'exclusivity', 'jealousy', 'heartbreak', 'infidelity', 'unrequited', 'engagement', 'breakup', 'flirtation', 'affair', 'longing'],
        'Conflict': ['rivalry', 'tension', 'enmity', 'grudge', 'feud', 'betrayal', 'conflict_cause', 'cold_war', 'hostility', 'vendetta', 'falling_out'],
        'Power': ['power_dynamic', 'dominance', 'dependency', 'control', 'leverage', 'hierarchy', 'servitude', 'authority_over', 'submission', 'influence_over', 'mutual_dependence'],
        'Trust & Standing': ['trust', 'respect', 'suspicion', 'reputation_between', 'reconciliation', 'distrust', 'contempt', 'affection', 'resentment', 'forgiveness', 'loyalty_felt', 'admiration', 'disappointment'],
        'Obligation': ['debt', 'favor', 'promise', 'alliance', 'contract_between', 'oath', 'loyalty_between', 'blood_oath', 'duty_owed', 'mutual_aid', 'conspiracy_shared'],
        'Dynamics': ['communication_style', 'recurring_pattern', 'distance', 'status_of_relationship', 'secret_between', 'last_interaction', 'frequency', 'role_in_pair', 'shared_activity'],
    },
    Events: {
        'Scenes': ['scene', 'encounter', 'conversation', 'action', 'arrival', 'departure', 'gesture', 'meeting', 'outing', 'reunion'],
        'Milestones': ['milestone', 'first_time', 'achievement', 'loss', 'birth', 'death', 'wedding', 'point_of_no_return', 'escalation', 'graduation', 'promotion', 'coming_of_age_event'],
        'Conflict': ['conflict', 'fight', 'battle', 'argument', 'chase', 'escape', 'ambush', 'standoff', 'defeat', 'victory', 'resolution', 'duel', 'siege', 'confrontation'],
        'Agreements': ['agreement', 'deal', 'bargain', 'oath_sworn', 'contract_signed', 'alliance_formed', 'surrender', 'promise_made', 'truce', 'negotiation', 'pact'],
        'Revelations': ['revelation', 'confession', 'discovery', 'secret_revealed', 'betrayal_revealed', 'truth_told', 'lie_exposed', 'realization', 'unmasking', 'admission'],
        'Change': ['change', 'transformation', 'decision', 'turning_point', 'status_change', 'relocation', 'departure_event', 'death_event', 'gain', 'reversal', 'awakening'],
        'Plans': ['plan', 'scheme', 'intention', 'threat_made', 'prediction', 'deadline_set', 'mission', 'goal_set', 'appointment', 'preparation', 'warning'],
        'Incidents': ['accident', 'crime', 'disaster', 'injury_event', 'rescue', 'theft', 'gift_given', 'mishap', 'sabotage', 'outburst'],
        'Sequence': ['step', 'journey_leg', 'timeline_beat', 'phase_event', 'episode'],
    },
    World: {
        'Lore': ['lore', 'myth', 'legend', 'prophecy', 'creation_story', 'cosmology', 'ancient_lore', 'world_premise', 'planes', 'origin_of_conflict'],
        'Rules': ['rule', 'law', 'magic_system', 'physics_rule', 'taboo', 'custom_rule', 'code', 'limitation', 'hard_rule', 'natural_law', 'forbidden_act'],
        'Factions': ['faction', 'organization', 'guild', 'government_body', 'military', 'cult', 'corporation', 'gang', 'noble_house', 'crime_syndicate', 'order', 'council'],
        'Culture': ['culture', 'tradition', 'ritual', 'holiday', 'etiquette', 'art', 'cuisine', 'dress_norm', 'language_world', 'festival', 'custom', 'taboo_cultural', 'norm', 'folklore'],
        'Politics': ['politics', 'ruler', 'regime', 'conflict_world', 'treaty', 'succession', 'diplomacy', 'power_struggle', 'rebellion', 'political_structure', 'faction_conflict', 'alliance_world'],
        'Economy': ['economy', 'trade', 'currency_world', 'industry', 'resource', 'scarcity', 'market', 'class_system', 'trade_route', 'commodity', 'guild_economy'],
        'History': ['history', 'war', 'founding_event', 'golden_age', 'fall', 'ancient_event', 'recent_event', 'fallen_empire', 'dynasty', 'cataclysm'],
        'Geography': ['geography', 'region', 'nation', 'landmark', 'terrain_world', 'climate_world', 'map', 'borders', 'continent', 'settlement', 'wilderness'],
        'Species & Peoples': ['species', 'race', 'world_bloodline', 'world_ancestry', 'monster', 'creature_type', 'demographics', 'tribe', 'people_group', 'beast'],
        'Religion': ['deity', 'faith', 'church', 'afterlife', 'sacred_site', 'religious_order', 'heresy', 'pantheon', 'doctrine', 'relic_holy'],
        'Technology Level': ['tech_level', 'invention', 'infrastructure', 'communication_world', 'transport_world', 'lost_technology', 'forbidden_science', 'innovation', 'energy_source'],
        'Threats': ['threat_world', 'enemy_force', 'plague', 'prophecy_doom', 'looming_danger', 'hazard_world', 'invasion', 'famine', 'apocalypse'],

        'Calendar': ['time', 'date', 'year', 'season', 'month', 'day_of_week', 'era', 'age_of_world', 'historical_timeline'],
        'Clock': ['time_of_day', 'hour', 'duration', 'elapsed_time', 'moment'],
        'Schedule': ['deadline', 'recurring_event', 'anniversary', 'curfew', 'shift', 'appointment_time'],
        'Cycles': ['cycle', 'phase', 'festival_date', 'market_day', 'lunar_phase', 'seasonal_cycle'],
        'Reckoning': ['timekeeping_system', 'calendar_system', 'time_since', 'countdown', 'epoch'],
    },
    Unsorted: {

        'Triage': ['misc', 'ambiguous', 'pending_promotion', 'meta_note', 'correction', 'ooc'],
    },
};

const DEFAULT_ASPECT = {
    People: 'status',
    Places: 'feature',
    Things: 'object',
    Relationships: 'history',
    Events: 'scene',
    World: 'lore',
    Unsorted: 'misc',
};

const LEGACY_ASPECT_MAP = {

    identity:   'identity',
    appearance: 'appearance',
    body:       'appearance',   
    background: 'childhood',    
    role:       'career',       

    mood:       'mood',
    goals:      'current_goal', 
    goal:       'current_goal',
    behavior:   'habits',       
    skills:     'skills',

    phobias:    'fears',
    phobia:     'fears',
    fear:       'fears',
    afraid_of:  'fears',
    looks:      'appearance',
    physical:   'appearance',
    physique:   'build',
    tattoo:     'tattoos',
    scar:       'scars',
    piercing:   'piercings',
    occupation: 'career',
    job:        'career',
    profession: 'career',
    clothing:   'current_clothing',
    clothes:    'current_clothing',
    outfit:     'current_clothing',
    money:      'finances',
    wealth:     'finances',
    personality:'temperament',
    trait:      'core_trait',
    flaws:      'flaw',
    belief:     'beliefs',
    value:      'values',
    motive:     'motivation',
    desire:     'desires',
    ambition:   'ambitions',
    dream:      'dreams',
    orientation_sexual: 'orientation',
    kink:       'kinks',
    habit:      'habits',
    vice:       'vices',
    secret:     'secrets',
    skill:      'skills',
    talent:     'talents',
    language:   'languages',
    residence_place: 'home',     
    location:   'current_location', 
    routine:    'daily_routine',
    pet:        'pets',
    hobby:      'hobbies',
    self_concept_self: 'self_concept',

    residence:  'function',     
    public:     'function',
    region:     'geography',    
    decor_place:'decor',

    'key-item': 'key_item',
    keyitem:    'key_item',
    item:       'object',
    gear:       'tool',
    armor:      'armor_item',
    food_item:  'food',
    value_of_item: 'worth',

    bond:       'friendship',   
    lover:      'romance',
    love:       'romance',
    relationship_status: 'status_of_relationship',

    historical_event: 'history',

    ambiguous_misc: 'misc',
};

export function mapLegacyCategory(category, fact) {
    const c = String(category || '').trim().toLowerCase();
    if (!c) return 'Unsorted';
    const scope = fact ? normalizeScope(fact.scope) : '';
    switch (c) {
        case 'identity':
        case 'behavior':
            return 'People';
        case 'status':
            return scope === 'place' ? 'Places' : 'People';
        case 'world':
            if (scope === 'place') return 'Places';
            if (scope === 'event') return 'Events';
            return 'World';
        case 'history':
            return 'Events';
        case 'relationships':
            return 'Relationships';
        case 'unsorted':
            return 'Unsorted';
        default:

            for (const canon of L1_CATEGORIES) {
                if (canon.toLowerCase() === c) return canon;
            }

            for (const canon of overlayCategories()) {
                if (canon.toLowerCase() === c) return canon;
            }

            return category;
    }
}

let _overlayVocabMemo = null;

let _overlayCatsMemo = null;

function getTaxonomyOverlay() {
    const ov = host.getExtensionSettings()?.taxonomyOverlay;
    return {
        categories: Array.isArray(ov?.categories) ? ov.categories : [],
        aspects: (ov?.aspects && typeof ov.aspects === 'object' && !Array.isArray(ov.aspects)) ? ov.aspects : {},
        subAreas: (ov?.subAreas && typeof ov.subAreas === 'object' && !Array.isArray(ov.subAreas)) ? ov.subAreas : {},
    };
}

function overlayCategories() {
    if (_overlayCatsMemo) return _overlayCatsMemo;
    const builtinLower = new Set(L1_CATEGORIES.map(c => c.toLowerCase()));
    const seen = new Set();
    const out = [];
    for (const raw of getTaxonomyOverlay().categories) {
        const name = String(raw || '').trim();
        if (!name) continue;
        const lc = name.toLowerCase();
        if (builtinLower.has(lc) || seen.has(lc)) continue; 
        seen.add(lc);
        out.push(name);
    }
    _overlayCatsMemo = out;
    return out;
}

export function effectiveCategories() {
    return [...L1_CATEGORIES, ...overlayCategories()];
}

function flatVocab(category) {
    const canon = mapLegacyCategory(category);
    if (!_overlayVocabMemo) _overlayVocabMemo = new Map();
    const cached = _overlayVocabMemo.get(canon);
    if (cached) return cached;

    const node = TAXONOMY[canon] || TAXONOMY.Unsorted;
    const builtin = Object.values(node).flat();

    const extra = getTaxonomyOverlay().aspects[canon];
    if (!Array.isArray(extra) || extra.length === 0) {
        _overlayVocabMemo.set(canon, builtin);
        return builtin;
    }
    const have = new Set(builtin);
    const merged = builtin.slice();
    for (const raw of extra) {
        const leaf = String(raw || '').trim().toLowerCase();
        if (leaf && !have.has(leaf)) { have.add(leaf); merged.push(leaf); }
    }
    _overlayVocabMemo.set(canon, merged);
    return merged;
}

function defaultAspectFor(category) {
    const canon = mapLegacyCategory(category);
    return DEFAULT_ASPECT[canon] || flatVocab(canon)[0] || 'misc';
}

export function normalizeAspect(v, category) {
    const a = String(v || '').trim().toLowerCase();
    const vocab = flatVocab(category);
    if (a && vocab.includes(a)) return a;

    if (a && Object.prototype.hasOwnProperty.call(LEGACY_ASPECT_MAP, a)) {
        const mapped = LEGACY_ASPECT_MAP[a];
        if (vocab.includes(mapped)) {
            addDebugLog('debug', `Legacy aspect remap: "${a}" → "${mapped}" (${category})`, {
                subsystem: 'db', event: 'fact.remapped', reason: 'LEGACY_ASPECT_REMAP',
                data: { category }, before: a, after: mapped,
            });
            return mapped;
        }
    }
    return defaultAspectFor(category);
}

export function deriveAspect(fact) {
    if (!fact) return 'misc';
    return normalizeAspect(fact.aspect, fact.category);
}

export function canonicalizeLeafSurface(v) {
    let s = String(v ?? '').trim().toLowerCase();
    if (!s) return '';
    s = s.replace(/^(?:a|an|the)\s+/, '');          
    s = s.replace(/[\s\-]+/g, '_');                  
    s = s.replace(/[^a-z0-9_]+/g, '');               
    s = s.replace(/_+/g, '_').replace(/^_+|_+$/g, ''); 
    return s;
}

export function buildSkeletonDatabases() {
    const out = {};

    for (const cat of effectiveCategories()) out[cat] = createEmptyDatabase(cat);
    return out;
}

export function withSkeleton(databases) {
    const out = buildSkeletonDatabases();
    for (const [cat, db] of Object.entries(databases || {})) out[cat] = db;
    return out;
}

const VALID_SCOPES = new Set(['character', 'place', 'event']);

function normalizeScope(v) {
    const s = String(v || '').trim().toLowerCase();
    return VALID_SCOPES.has(s) ? s : '';
}

export function deriveScope(fact) {
    const explicit = normalizeScope(fact?.scope);
    if (explicit) return explicit;
    if (isSequenceFact(fact)) return 'event';

    switch (mapLegacyCategory(fact?.category).toLowerCase()) {
        case 'events': return 'event';
        case 'places': return 'place';
        case 'world': return 'place';
        default: return 'character'; 
    }
}

export function isActiveFact(fact) {
    return !(fact && fact.active === false);
}

function isHotFact(fact) {
    return !(fact && fact.cold === true);
}

export function isColdFact(fact) {
    return !!(fact && fact.cold === true);
}

// Cold because the budget said so, and therefore releasable by the budget. A cold
// row with no coldVia predates the field and is read as a verdict — see the block
// above markFactCold for why that is the safe default rather than the lenient one.
//
// Exported because the sheet's NEED/recovered resolver has the same question to
// ask: a ref the extraction agent explicitly asked for must not be dropped over
// bookkeeping, only over a judgement. See resolveRefs in agent-memory.js.
export function isBudgetCold(fact) {
    return !!fact && fact.cold === true && fact.coldVia === COLD_VIA_BUDGET;
}

function uncoldFact(fact, category, reason = 'COLD_REACTIVATED', detail = '') {
    if (!fact || fact.cold !== true) return false;
    delete fact.cold;
    delete fact.coldVia;
    addDebugLog('info', `Fact resurfaced (un-cold): [${category}] ${fact.key}${detail ? ` — ${detail}` : ''}`, {
        subsystem: 'db', event: 'fact.resurfaced', reason,
        data: { category, key: fact.key, salienceScore: Number(salienceScore(fact, Date.now()).toFixed(3)) },
    });
    return true;
}

// WHY a fact is cold, not just THAT it is. Two callers demote for two completely
// different reasons and only one of them may ever be undone automatically:
//
//   VERDICT — a #CONFLICT loser, a merge loser, a #REEVAL drop, an explicit
//             mark_cold, a canonicalisation shadow copy. Someone JUDGED this row
//             wrong or redundant. Nothing may resurface it except an explicit
//             un-cold or a fresh write; the hot-set budget has no standing to
//             overrule a verdict.
//   BUDGET  — coldTierOverflow trimmed the tail because the category exceeded the
//             hot-set budget. That is bookkeeping, and raising the budget must
//             give those rows back.
//
// Without this field the budget branch un-colds everything it finds, so every
// verdict in the system had a lifetime of one turn: the refuted value came back
// under "established truth", and the canonicalisation shadow copies returned as
// duplicate sheet rows because composeSheet dedupes on `category:key`, which a
// cross-category twin does not collide on.
//
// A cold fact from before this field existed carries no coldVia. Those read as
// VERDICT — the conservative direction: a row that stays cold one release too
// long is a missing line, a resurfaced verdict is a wrong line sold as truth.
export const COLD_VIA_VERDICT = 'VERDICT';
export const COLD_VIA_BUDGET = 'BUDGET';

export function markFactCold(fact, category, reason = 'DEMOTED_LOW_VALUE', detail = '', via = COLD_VIA_VERDICT) {
    if (!fact || fact.cold === true) return false;
    fact.cold = true;
    fact.coldVia = via;
    addDebugLog('info', `Fact cold-tiered (kept, deprioritized): [${category}] ${fact.key}${detail ? ` — ${detail}` : ''}`, {
        subsystem: 'db', event: 'fact.demoted', reason,
        data: { category, key: fact.key, salienceScore: Number(salienceScore(fact, Date.now()).toFixed(3)) },
    });
    return true;
}

function shouldSupersede(existing, incoming, explicitSignal) {
    if (!existing || !incoming) return false;

    if (factValuesEqual(existing.value, incoming.value)) return false;

    if (explicitSignal === true) return true;

    const existingKind = normalizeKind(existing.kind);
    if (existingKind !== 'state') return false;
    const incHasKind = incoming.kind !== undefined && incoming.kind !== null && String(incoming.kind).trim();
    if (incHasKind && normalizeKind(incoming.kind) !== 'state') return false;
    return true;
}

function factValuesEqual(a, b) {
    return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}

function salienceScore(fact, now, penalizeCold = false) {

    if (fact && fact.active === false) {
        const at = Number(fact.supersededAt) || Number(fact.lastUpdated) || 0;
        const ageDays = at > 0 ? Math.max(0, (now - at) / 86400000) : 36500;
        return -1 + Math.pow(0.5, ageDays / 7) * 0.001; 
    }
    const importance = clampImportance(fact?.importance);
    const kind = normalizeKind(fact?.kind);

    const last = effectiveRecencyTs(fact);
    const ageDays = last > 0 ? Math.max(0, (now - last) / 86400000) : 36500; 
    const halfLife = HALF_LIFE_DAYS[kind] || HALF_LIFE_DAYS.trait;
    const recency = Math.pow(0.5, ageDays / halfLife); 

    const raw = IMPORTANCE_WEIGHT * (importance / 5) + RECENCY_WEIGHT * recency + useBonus(fact?.useCount);

    if (penalizeCold && fact && fact.cold === true) {
        return COLD_BASE - COLD_SPAN + (raw / 1.05) * COLD_SPAN;
    }
    return raw;
}

function getContext() {
    const ctx = host.getCtx();
    if (!ctx) throw new Error('SillyTavern context unavailable');
    return ctx;
}

function getCharacterAvatar() {
    const context = getContext();
    return context.characters?.[context.characterId]?.avatar || null;
}

function getCurrentChatIdSafe() {
    try {
        const ctx = host.getCtx();
        return ctx?.getCurrentChatId?.() || ctx?.chatId || '';
    } catch {
        return '';
    }
}

const IDB_NAME = 'bf_memory_pipeline';
const IDB_VERSION = 1;
const IDB_STORE = 'character_dbs';

const SNAPSHOT_SCHEMA_VERSION = 1;

let _idbCapable = 'unknown';
let _idbConnPromise = null; 
let _idbFallbackLogged = false; 

function disableIdb(reason) {
    _idbCapable = false;
    if (_idbFallbackLogged) return;
    _idbFallbackLogged = true;
    try {
        addDebugLog('info', `IndexedDB unavailable — using durable attachments only (${reason})`, {
            subsystem: 'db', event: 'storage.fallback', reason: 'IDB_UNAVAILABLE', data: { why: reason },
        });
    } catch {  }
}

function idbAvailable() {
    if (_idbCapable !== 'unknown') return _idbCapable;
    let ok;
    try {
        ok = (typeof indexedDB !== 'undefined' && indexedDB !== null);
    } catch {
        ok = false;
    }
    if (!ok) { disableIdb('indexedDB global unavailable'); }
    else { _idbCapable = true; }
    return _idbCapable;
}

function openIdb() {
    if (!idbAvailable()) return Promise.reject(new Error('IndexedDB unavailable'));
    if (_idbConnPromise) return _idbConnPromise;
    _idbConnPromise = new Promise((resolve, reject) => {
        let req;
        try {
            req = indexedDB.open(IDB_NAME, IDB_VERSION);
        } catch (e) {
            disableIdb('open() threw'); 
            reject(e);
            return;
        }
        req.onupgradeneeded = () => {
            try {
                const db = req.result;
                if (!db.objectStoreNames.contains(IDB_STORE)) {

                    db.createObjectStore(IDB_STORE, { keyPath: 'avatar' });
                }
            } catch (e) {
                console.error('[BFMemory] IDB upgrade failed', e);
            }
        };
        req.onsuccess = () => {
            const db = req.result;

            db.onversionchange = () => { try { db.close(); } catch {  } _idbConnPromise = null; };
            resolve(db);
        };
        req.onerror = () => { disableIdb('open error'); reject(req.error || new Error('IDB open error')); };
        req.onblocked = () => { reject(new Error('IDB open blocked')); };
    }).catch((e) => {

        _idbConnPromise = null;
        throw e;
    });
    return _idbConnPromise;
}

function idbRequest(db, mode, fn) {
    return new Promise((resolve, reject) => {
        let tx;
        try { tx = db.transaction(IDB_STORE, mode); } catch (e) { reject(e); return; }
        let req;
        try { req = fn(tx.objectStore(IDB_STORE)); } catch (e) { reject(e); return; }
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('IDB request error'));
        tx.onabort = () => reject(tx.error || new Error('IDB tx aborted'));
        tx.onerror = () => reject(tx.error || new Error('IDB tx error'));
    });
}

async function idbGetRecord(avatar) {
    const db = await openIdb();
    const rec = await idbRequest(db, 'readonly', (store) => store.get(avatar));
    return rec || null;
}

async function idbPutDatabases(avatar, databases, updatedAt, deletedCategories) {
    const db = await openIdb();
    const stamp = Number(updatedAt) || Date.now();
    const record = { avatar, databases: databases || {}, updatedAt: stamp, schema: SNAPSHOT_SCHEMA_VERSION };
    if (deletedCategories && typeof deletedCategories === 'object' && Object.keys(deletedCategories).length > 0) {
        record.deletedCategories = deletedCategories;
    }
    await idbRequest(db, 'readwrite', (store) => store.put(record));
    return stamp;
}

async function idbUpdateRecord(avatar, mutator) {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
        let tx;
        try { tx = db.transaction(IDB_STORE, 'readwrite'); } catch (e) { reject(e); return; }
        let getReq;
        let written = null;
        try { getReq = tx.objectStore(IDB_STORE).get(avatar); } catch (e) { reject(e); return; }
        getReq.onsuccess = () => {
            try {
                const result = mutator(getReq.result || null);
                if (result && typeof result === 'object') {
                    const record = {
                        avatar,
                        databases: result.databases || {},
                        updatedAt: Number(result.updatedAt) || Date.now(),
                        schema: SNAPSHOT_SCHEMA_VERSION,
                    };
                    if (result.deletedCategories && typeof result.deletedCategories === 'object'
                        && Object.keys(result.deletedCategories).length > 0) {
                        record.deletedCategories = result.deletedCategories;
                    }

                    tx.objectStore(IDB_STORE).put(record);
                    written = record;
                }
            } catch (e) {
                try { tx.abort(); } catch {  }
                reject(e);
                return;
            }
        };
        getReq.onerror = () => reject(getReq.error || new Error('IDB get error'));
        tx.oncomplete = () => resolve(written);
        tx.onabort = () => reject(tx.error || new Error('IDB tx aborted'));
        tx.onerror = () => reject(tx.error || new Error('IDB tx error'));
    });
}

function mergeTombstones(a, b) {
    const out = {};
    for (const src of [a, b]) {
        if (!src || typeof src !== 'object') continue;
        for (const [cat, ts] of Object.entries(src)) {
            const t = Number(ts) || 0;
            if (t > (Number(out[cat]) || 0)) out[cat] = t;
        }
    }
    return out;
}

const SNAPSHOT_THROTTLE_MS = 15000; 
const _snapshotDirty = new Set();   
const _snapshotTimers = new Map();  
let _snapshotInFlight = false;      

function scheduleSnapshot(avatar) {
    if (!avatar || !idbAvailable()) return;
    _snapshotDirty.add(avatar);
    if (_snapshotTimers.has(avatar)) return; 
    const id = setTimeout(() => {
        _snapshotTimers.delete(avatar);

        snapshotAvatar(avatar).catch((e) => console.error('[BFMemory] snapshot failed', e));
    }, SNAPSHOT_THROTTLE_MS);
    _snapshotTimers.set(avatar, id);
}

async function snapshotAvatar(avatar, { reconcileDeletes = true } = {}) {
    if (!avatar || !idbAvailable()) return;
    if (_snapshotInFlight) { _snapshotDirty.add(avatar); return; } 
    if (!_snapshotDirty.has(avatar)) return;
    _snapshotInFlight = true;
    _snapshotDirty.delete(avatar);
    try {
        const rec = await idbGetRecord(avatar);
        if (!rec || !rec.databases) return;
        const stamp = Number(rec.updatedAt) || Date.now();

        const liveCategories = new Set();

        const tombs = (rec.deletedCategories && typeof rec.deletedCategories === 'object'
            && Object.keys(rec.deletedCategories).length > 0) ? rec.deletedCategories : null;
        for (const [category, sdb] of Object.entries(rec.databases)) {
            if (!sdb || !Array.isArray(sdb.facts) || sdb.facts.length === 0) continue;
            liveCategories.add(category.toLowerCase().replace(/[^a-z0-9]/g, '_'));
            const payload = { ...sdb, category, snapshotVersion: SNAPSHOT_SCHEMA_VERSION, updatedAt: stamp };
            if (tombs) payload.deletedCategories = tombs;
            try {
                await saveDatabaseToAttachment(avatar, payload);
            } catch (e) {
                console.error(`[BFMemory] snapshot of "${category}" failed`, e);
            }
        }

        let reconciled = 0;
        if (reconcileDeletes) {
            reconciled = await reconcileDeletedAttachments(avatar, liveCategories);
        }
        addDebugLog('debug', 'Durable snapshot written (IDB → attachments)', {
            subsystem: 'db', event: 'db.snapshot',
            data: { updatedAt: stamp, liveCategories: liveCategories.size, attachmentsRemoved: reconciled, reconcileDeletes },
        });
    } catch (e) {
        _snapshotDirty.add(avatar); 
        console.error('[BFMemory] snapshotAvatar failed', e);
    } finally {
        _snapshotInFlight = false;
        // Re-arm any avatars deferred (or re-dirtied on failure) while this ran,
        // so a dirty avatar is never stranded until the next write / forced flush.
        for (const pending of _snapshotDirty) scheduleSnapshot(pending);
    }
}

async function reconcileDeletedAttachments(avatar, liveSlugs) {
    const context = getContext();
    const attachments = context.extensionSettings?.character_attachments?.[avatar];
    if (!Array.isArray(attachments) || attachments.length === 0) return 0;
    let removed = 0;

    for (let i = attachments.length - 1; i >= 0; i--) {
        const a = attachments[i];
        const name = a && a.name;
        if (typeof name !== 'string' || !name.startsWith(DB_PREFIX) || !name.endsWith('.json')) continue;
        const slug = name.slice(DB_PREFIX.length, -'.json'.length);
        if (liveSlugs.has(slug)) continue; 
        try {
            await deleteAttachmentFile(a.url);
        } catch {  }
        attachments.splice(i, 1);
        removed++;
    }
    if (removed > 0) context.saveSettingsDebounced?.();
    return removed;
}

export function cancelPendingSnapshot(avatar) {
    try {
        const target = avatar || getCharacterAvatar();
        if (!target) return;
        if (_snapshotTimers.has(target)) {
            clearTimeout(_snapshotTimers.get(target));
            _snapshotTimers.delete(target);
        }
        _snapshotDirty.delete(target);
        addDebugLog('debug', 'Pending snapshot cancelled (destructive op)', {
            subsystem: 'db', event: 'db.snapshot.cancelled', reason: 'DESTRUCTIVE_OP',
            data: { avatar: target },
        });
    } catch (e) {
        console.error('[BFMemory] cancelPendingSnapshot failed', e);
    }
}

export async function flushSnapshotNow({ avatar: pinnedAvatar, reconcileDeletes = true } = {}) {
    try {
        if (!idbAvailable()) return;
        const avatar = pinnedAvatar || getCharacterAvatar();
        if (!avatar) return;
        if (_snapshotTimers.has(avatar)) { clearTimeout(_snapshotTimers.get(avatar)); _snapshotTimers.delete(avatar); }
        _snapshotDirty.add(avatar); 
        await snapshotAvatar(avatar, { reconcileDeletes });
    } catch (e) {
        console.error('[BFMemory] flushSnapshotNow failed', e);
    }
}

// Storage tiers (all called "database" elsewhere — this is the map):
//   IndexedDB           = source of truth (per avatar, write-through every action).
//   Attachment bf_memory_db_*.json = durable MIRROR of IDB (debounced 15s, force-flushed on chat-switch/unload).
//   _dbCache            = in-memory read cache (per avatar+chat), invalidated on every save/delete.
//   dbProfiles (settings.js) = per-chat named checkpoints that swap the working store on autoload.
let _dbCache = null;
let _dbCacheAvatar = null;
let _dbCacheChatId = null;    
let _dbCachePromise = null;   

export function invalidateDatabaseCache() {
    _dbCache = null;
    _dbCacheAvatar = null;
    _dbCacheChatId = null;
    _dbCachePromise = null;

    invalidateMemoryIndex();
}

export async function getAllDatabases() {
    const avatar = getCharacterAvatar();
    if (!avatar) return {};

    const chatId = getCurrentChatIdSafe();

    if (_dbCache && _dbCacheAvatar === avatar && _dbCacheChatId === chatId) return _dbCache;

    if (_dbCachePromise && _dbCacheAvatar === avatar && _dbCacheChatId === chatId) return _dbCachePromise;

    _dbCacheAvatar = avatar;
    _dbCacheChatId = chatId;
    _dbCachePromise = (async () => {
        try {
            const result = await loadAllDatabases(avatar);

            if (_dbCacheAvatar === avatar && _dbCacheChatId === chatId) _dbCache = result;
            return result;
        } finally {

            if (_dbCacheAvatar === avatar && _dbCacheChatId === chatId) _dbCachePromise = null;
        }
    })();
    return _dbCachePromise;
}

let _idxCache = null;        
let _idxCacheAvatar = null;  

function invalidateMemoryIndex() {
    _idxCache = null;
    _idxCacheAvatar = null;
}

function factTokens(fact) {
    const text = `${fact.key || ''} ${fact.value || ''} ${(fact.tags || []).join(' ')} ${(fact.aliases || []).join(' ')}`;
    return wordTokens(text);
}

export function buildMemoryIndex(databases) {
    const byCatAspect = new Map();
    const bySubject = new Map();
    const byToken = new Map();
    const aspectCounts = new Map();
    let totalFacts = 0;
    const nameReg = new Map();

    const add = (map, key, entry) => {
        if (!key) return;
        let arr = map.get(key);
        if (!arr) { arr = []; map.set(key, arr); }
        arr.push(entry);
    };

    for (const [category, db] of Object.entries(databases || {})) {
        const catLower = category.toLowerCase();
        for (const fact of (db.facts || [])) {
            if (!fact || typeof fact !== 'object') continue;
            if (!isActiveFact(fact)) continue; 
            totalFacts++;
            const entry = { fact, category };
            const aspect = deriveAspect(fact);
            add(byCatAspect, `${catLower}||${aspect}`, entry);
            add(bySubject, deriveSubject(fact), entry);
            collectFactNames(nameReg, fact);
            for (const tok of factTokens(fact)) add(byToken, tok, entry);

            if (isHotFact(fact)) {
                let m = aspectCounts.get(category);
                if (!m) { m = new Map(); aspectCounts.set(category, m); }
                m.set(aspect, (m.get(aspect) || 0) + 1);
            }
        }
    }
    _nameRegistry = nameReg;
    return { byCatAspect, bySubject, byToken, aspectCounts, totalFacts };
}

// ── CHARACTER NAME REGISTRY ──────────────────────────────────────────────────
// Maps every name/alias a character has been referred to by → their canonical
// subject token (the key prefix their facts live under), so "Trish Mitchells"
// resolves to the same character as "Trish". Rebuilt as a side effect of
// buildMemoryIndex (which already walks every fact); while empty, sameCharacter
// falls back to first-name matching so nothing depends on build order.
const NAME_ASPECTS = new Set([
    'name', 'aliases', 'birth_name', 'true_name', 'codename', 'epithet',
    'past_alias', 'middle_name', 'surname', 'identity', 'nickname',
]);

let _nameRegistry = new Map();

function normCharName(s) {
    return String(s || '').trim().toLowerCase()
        .replace(/^@/, '')
        .replace(/[_]+/g, ' ')
        .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function registerNameInto(reg, name, subject) {
    const n = normCharName(name);
    if (!n || !subject) return;
    if (!reg.has(n)) reg.set(n, subject);
}

function collectFactNames(reg, fact) {
    // deriveScope(), not the raw field. The raw test read a MISSING scope as
    // "possibly a character" and let the record through — harmless while every writer
    // stamped a scope, but World rows carry none now (see scopeFromCategory in
    // memory-tools.js), and a World row's subject is a key prefix like 'time' or
    // 'village'. Those would land in the registry that resolveGenericKeyPrefix() and
    // lookupCharacterAlias() treat as the list of known character names.
    // deriveScope() falls back to the owning category, so Places/Events/World rows
    // are excluded whether or not they carry the field, and everything that resolves
    // to 'character' — including Unsorted and a fact with no category at all —
    // still gets in exactly as before.
    if (deriveScope(fact) !== 'character') return;
    const subject = deriveSubject(fact);
    if (!subject) return;
    registerNameInto(reg, subject, subject);
    for (const a of (Array.isArray(fact.aliases) ? fact.aliases : [])) registerNameInto(reg, a, subject);
    const aspect = deriveAspect(fact);
    if (!NAME_ASPECTS.has(aspect)) return;
    const value = String(fact.value || '').trim();
    if (!value || value.length > 80) return;
    if (aspect === 'aliases' || aspect === 'past_alias') {
        for (const part of value.split(/[,;/]|\baka\b/i)) registerNameInto(reg, part, subject);
    } else {
        registerNameInto(reg, value, subject);
    }
}

// Direct registry lookup only — returns '' for unknown names (no guessing).
export function lookupCharacterAlias(name) {
    return _nameRegistry.get(normCharName(name)) || '';
}

// Immediate registration (e.g. right after an add_alias write) so resolution
// works within the same run, before the index is next rebuilt.
export function registerCharacterAlias(alias, canonicalToken) {
    const token = String(canonicalToken || '').trim().toLowerCase();
    if (!token) return;
    registerNameInto(_nameRegistry, alias, token);
}

// Canonical subject token for any way of writing a character's name. Registry
// hit wins (full phrase, then first name); otherwise the first name token is
// the best guess — which also makes "Trish" match "Trish Mitchells" cold.
export function resolveCharacterToken(name) {
    const n = normCharName(resolveGenericSubjectToken(normCharName(name)));
    if (!n) return '';
    const direct = _nameRegistry.get(n);
    if (direct) return direct;
    const first = n.split(' ')[0];
    return _nameRegistry.get(first) || first;
}

export function sameCharacter(a, b) {
    const na = normCharName(a), nb = normCharName(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    const ta = resolveCharacterToken(na);
    return !!ta && ta === resolveCharacterToken(nb);
}

export async function getMemoryIndex() {
    const avatar = getCharacterAvatar();
    if (_idxCache && _idxCacheAvatar === avatar) return _idxCache;
    const databases = await getAllDatabases();

    const idx = buildMemoryIndex(databases);
    if (getCharacterAvatar() === avatar) {
        _idxCache = idx;
        _idxCacheAvatar = avatar;
    }
    return idx;
}

export function searchFactsIndexed(index, databases, keywords) {
    const MAX_PRIMARY = 8;
    const results = [];
    const nameWords = getCharacterNameWords();
    const lowerKeywords = keywords.map(k => k.toLowerCase());

    const keywordWordSets = lowerKeywords.map(kw =>
        wordTokens(kw).filter(w => !nameWords.has(w))
    ).filter(words => words.length > 0);

    const candidates = new Map(); 
    const allKeyWords = new Set();
    for (const words of keywordWordSets) for (const w of words) allKeyWords.add(w);
    const pullBucket = (tok) => {
        const bucket = index.byToken.get(tok);
        if (bucket) for (const e of bucket) candidates.set(`${e.category}:${e.fact.key}`, e);
    };
    for (const word of allKeyWords) pullBucket(word); 

    for (const token of index.byToken.keys()) {
        for (const word of allKeyWords) {
            if (token === word) continue; 
            if (token.includes(word) || word.includes(token)) { pullBucket(token); break; }
        }
    }

    for (const cat of collectCategoriesFromIndex(index)) {
        const catLower = cat.toLowerCase();
        const catHit = keywordWordSets.some(words => words.some(w => catLower.includes(w)));
        if (!catHit) continue;

        for (const [bucketKey, entries] of index.byCatAspect) {
            if (bucketKey.slice(0, bucketKey.indexOf('||')) !== catLower) continue;
            for (const e of entries) candidates.set(`${e.category}:${e.fact.key}`, e);
        }
    }

    const candidateList = [...candidates.values()];

    for (const { fact, category } of candidateList) {
        const categoryLower = category.toLowerCase();

        const factText = `${fact.key} ${fact.value} ${(fact.tags || []).join(' ')} ${(fact.aliases || []).join(' ')}`.toLowerCase();

        const directMatch = keywordWordSets.some(words => {
            if (words.length === 0) return false;
            const matchCount = words.filter(word => factText.includes(word) || categoryLower.includes(word)).length;
            if (words.length === 1) return matchCount >= 1;
            return matchCount >= 2;
        });

        if (directMatch) {
            results.push({ fact, category, tier: 'primary' });
            continue;
        }

        if (fact.relationships) {
            const secondaryMatch = (fact.relationships.secondary || []).some(ref => {
                const refLower = ref.toLowerCase();
                return keywordWordSets.some(words => words.some(word => refLower.includes(word)));
            });
            if (secondaryMatch) { results.push({ fact, category, tier: 'secondary' }); continue; }
            const tertiaryMatch = (fact.relationships.tertiary || []).some(ref => {
                const refLower = ref.toLowerCase();
                return keywordWordSets.some(words => words.some(word => refLower.includes(word)));
            });
            if (tertiaryMatch) results.push({ fact, category, tier: 'tertiary' });
        }
    }

    const primaryResults = results.filter(r => r.tier === 'primary');
    if (primaryResults.length > MAX_PRIMARY) {
        let toDemote = primaryResults.length - MAX_PRIMARY;
        for (const result of results) {
            if (toDemote <= 0) break;
            if (result.tier === 'primary' && isColdFact(result.fact)) { result.tier = 'secondary'; toDemote--; }
        }
        for (const result of results) {
            if (toDemote <= 0) break;
            if (result.tier === 'primary') { result.tier = 'secondary'; toDemote--; }
        }
    }

    const primaryFacts = results.filter(r => r.tier === 'primary');
    const alreadyFound = new Set(results.map(r => `${r.category}:${r.fact.key}`));
    for (const primaryResult of primaryFacts) {
        if (!primaryResult.fact.relationships) continue;
        const relatedRefs = [
            ...(primaryResult.fact.relationships.primary || []),
            ...(primaryResult.fact.relationships.secondary || []),
        ];
        for (const ref of relatedRefs) {
            const refLower = String(ref).toLowerCase();

            for (const w of wordTokens(refLower)) {
                const bucket = index.byToken.get(w);
                if (!bucket) continue;
                for (const { fact, category } of bucket) {
                    const id = `${category}:${fact.key}`;
                    if (alreadyFound.has(id)) continue;
                    const factIdentifiers = `${category} ${fact.key} ${(fact.tags || []).join(' ')}`.toLowerCase();
                    if (factIdentifiers.includes(refLower)) {
                        results.push({ fact, category, tier: 'secondary' });
                        alreadyFound.add(id);
                    }
                }
            }
        }
    }

    addDebugLog('debug', `Indexed keyword search: ${candidateList.length} candidate(s) → ${results.length} ranked hit(s)`, {
        subsystem: 'retrieval', event: 'retrieval.indexed',
        data: { byIndex: true, candidateCount: candidateList.length, op: 'searchFacts', results: results.length },
    });
    return results;
}

function collectCategoriesFromIndex(index) {
    const seen = new Set();
    const cats = [];
    for (const entries of index.byCatAspect.values()) {
        for (const e of entries) {
            if (!seen.has(e.category)) { seen.add(e.category); cats.push(e.category); }
        }

    }
    return cats;
}

export function summarizeMenuIndexed(index) {

    const present = new Set(index.aspectCounts.keys());
    const ordered = [];
    for (const c of MENU_CATEGORY_ORDER) {
        const found = [...present].find(p => p.toLowerCase() === c.toLowerCase());
        if (found) ordered.push(found);
    }
    for (const c of present) {
        if (!MENU_CATEGORY_ORDER.some(m => m.toLowerCase() === c.toLowerCase())) ordered.push(c);
    }

    const lines = [];
    let aspectCount = 0;
    for (const name of ordered) {
        const counts = index.aspectCounts.get(name);
        if (!counts || counts.size === 0) continue;
        const vocab = flatVocab(name);
        const parts = vocab.filter(a => (counts.get(a) || 0) > 0).map(a => `${a}(${counts.get(a)})`);
        const extras = [...counts.keys()]
            .filter(a => !vocab.includes(a) && counts.get(a) > 0)
            .sort((a, b) => (counts.get(b) - counts.get(a)) || String(a).localeCompare(String(b)));
        for (const a of extras) parts.push(`${a}(${counts.get(a)})`);
        aspectCount += parts.length;
        if (parts.length) lines.push(`${name}: ${parts.join(', ')}`);
    }
    addDebugLog('debug', `Indexed menu: ${lines.length} populated categor(ies), ${aspectCount} aspect drawer(s)`, {
        subsystem: 'retrieval', event: 'retrieval.indexed',
        data: { byIndex: true, candidateCount: aspectCount, op: 'summarizeMenu', categories: lines.length },
    });
    return lines.join('\n');
}

// What makes two records under the same key the SAME KNOWLEDGE rather than two
// independent observations. The set is exactly the fields that decide what a record
// ASSERTS, how buildFactLine RENDERS it, and how salienceScore RANKS it:
//
//   value       the assertion itself (trim + lowercase, via factValuesEqual)
//   context     the note. buildFactLine prints the note INSTEAD of the value when one
//               is present (compact supply rows print `value — note…`, still both),
//               so two rows with different notes read differently on the
//               sheet however well their values match. Comparing value alone deleted
//               an importance-5 World lore record, note and all, in favour of an
//               importance-2 Places one-liner.
//   importance  the premise floor selects on it, COLD_TIER_PROTECT_IMPORTANCE exempts
//               on it, and it is 65% of salience. Two rows scored differently were
//               judged differently.
//   aspect      compared RAW, not through deriveAspect(): an aspect resolves against
//               the OWNING category's vocabulary, so a genuine duplicate reads
//               'time_since' in World and 'feature' in Places and would never match
//               itself. The stored string is the thing the writer chose.
//   kind        selects the half-life and both maintenance candidate sets.
//   knownBy     the visibility gate. A row visible to everyone and a row gated on
//               four names are not interchangeable whatever they say.
//
// Deliberately NOT compared — tags, aliases, involved, agentLinks, relationships:
// autoLinkFact() and upsertFact()'s merge grow those independently on each copy of a
// duplicated pair (six of the analysed run's autolink edges landed on shadow copies
// alone), so requiring equality there would make every real duplicate look distinct.
// Nothing is at risk either way now that the loser is kept. lastUpdated, createdAt,
// source, useCount/lastUsedAt and seenCount/lastSeenAt are bookkeeping, re-stamped by
// any touch including a note-only edit. `cold` and `active` are status, not content — and excluding them
// is what lets an already-resolved pair be recognised as resolved on the next load.
//
// srcId is a DISCRIMINATOR and a CONFIRMATION, never the evidence. Two records that
// both carry an srcId and disagree came from different messages, so they are
// independent observations even when their content matches — that is the one thing
// srcId can settle alone. Equality proves nothing on its own: srcId is written only
// `if (ctx.srcId)` and postdates most of the legacy store this pass exists to clean,
// so `'' === ''` held for every old record and the old predicate silently collapsed
// to "same key, same value".
function duplicateEvidence(a, b) {
    const differing = [];
    if (!factValuesEqual(a.value, b.value)) differing.push('value');
    if (!factValuesEqual(a.context, b.context)) differing.push('context');
    if (clampImportance(a.importance) !== clampImportance(b.importance)) differing.push('importance');
    if (rawAspectToken(a) !== rawAspectToken(b)) differing.push('aspect');
    if (normalizeKind(a.kind) !== normalizeKind(b.kind)) differing.push('kind');
    if (nameSetToken(a.knownBy) !== nameSetToken(b.knownBy)) differing.push('knownBy');

    const srcA = String(a.srcId || '').trim();
    const srcB = String(b.srcId || '').trim();
    if (srcA && srcB && srcA !== srcB) differing.push('srcId');

    return {
        duplicate: differing.length === 0,
        confirmedBySrcId: !!srcA && srcA === srcB,
        differing,
    };
}

function rawAspectToken(fact) {
    return String(fact?.aspect || '').trim().toLowerCase();
}

function nameSetToken(list) {
    if (!Array.isArray(list)) return '';
    return [...new Set(list.map(n => String(n ?? '').trim().toLowerCase()).filter(Boolean))].sort().join('|');
}

// mapLegacyCategory() is not only a v0.x schema shim. Its `world` + scope:'place'
// branch reclassifies facts the CURRENT extraction agent writes every session, so it
// keeps firing forever on a live store. That reclassification used to happen only
// inside loadAllDatabasesFromAttachments() — a parse whose result is discarded
// whenever IndexedDB is authoritative — so in the analysed run the same 8 keys were
// re-remapped on every load (70 LEGACY_CATEGORY_REMAP events, 13 passes) and never
// actually moved. Worse: the parse DID empty World in the outgoing map, the clobber
// guard below read the emptied category as data loss and restored it from IDB, and
// the store ended up carrying both copies permanently — 8 of 64 rows, 8 of 43
// digest lines, 4 of 15 premise-floor slots. scopeFromCategory() in memory-tools.js
// no longer stamps scope:'place' onto a World write, so that branch is a legacy
// branch again and this pass has a finite input.
//
// This pass runs the same mapping over the AUTHORITATIVE map after load, and the
// caller persists the result. That is what makes it converge: everything it can move
// is moved once and written back, so the second load finds nothing to do.
// Idempotency is the contract — report.changed must be false on the second call.
//
// NOTHING HERE DELETES. Every other demotion in this codebase cold-tiers instead of
// erasing — the #REEVAL drop, mark_cold, merge_facts' loser, the #CONFLICT loser —
// and the prompts promise that repeatedly. A migration that silently removed records
// on the first load after an upgrade would break that promise at the worst possible
// moment, on a store the user cannot diff. A duplicate is marked cold and stays
// listed in the DB panel, where it can be read and un-colded.
//
// Nothing MOVES onto an occupied key either. findFactMatch() returns the FIRST record
// carrying a key, so two same-key records inside one category would shadow each other
// for every later read, write and supersede. When source and destination both hold the
// key, both records keep their category and only the `cold` flag moves — which is also
// what makes the resolution idempotent, since markFactCold() is a no-op the second time.
function canonicalizeCategories(databases) {
    const report = {
        changed: false, moved: 0, demotedDuplicate: 0, demotedCollision: 0,
        alreadyResolved: 0, stamped: 0, emptied: [], byPair: {}, samples: [],
    };
    if (!databases || typeof databases !== 'object') return report;

    const sample = (op, entry) => { if (report.samples.length < 12) report.samples.push({ op, ...entry }); };

    // Snapshotted before the loop: a destination db created mid-pass needs no visit
    // of its own, and every target mapLegacyCategory() can produce is a fixpoint
    // (the canonical L1 names map to themselves; only 'World' can move, and only
    // out of World).
    for (const [cat, db] of Object.entries(databases)) {
        if (!db || !Array.isArray(db.facts) || db.facts.length === 0) continue;
        const keep = [];
        for (const fact of db.facts) {
            if (!fact || typeof fact !== 'object') { keep.push(fact); continue; }

            const target = mapLegacyCategory(cat, fact);
            if (!target || target === cat) {
                // Stamping the owning category onto the record is a GLOBAL
                // normalization, not a repair of the eight known ghosts: the object
                // execWriteFact() builds carries no `category` field at all, so this
                // fires once for every agent-written fact in every store. What it
                // changes downstream is deriveAspect(), which resolves fact.aspect
                // against mapLegacyCategory(fact.category)'s vocabulary — undefined
                // resolves against Unsorted, which is why the analysed store showed
                // aspectCounts.World = {misc: 8}. Re-resolving against the category
                // the record actually lives in is strictly better or neutral: an
                // aspect in that vocabulary now survives, and one that is not lands
                // on that category's DEFAULT_ASPECT, which is what it already
                // rendered as.
                //
                // THE ONE-TIME CLAIM THIS COMMENT USED TO MAKE WAS FALSE, and is now
                // true for a different reason. It said the first load per character
                // rewrites the record and the second finds fact.category === cat for
                // every row, so it never runs again. That only ever held for a store
                // that had stopped growing: every agent write arrived with no
                // `category` field, so each load stamped the facts written since the
                // last one, set report.changed and paid another full-store IDB
                // rewrite plus a snapshot — measured as stamped = 1,3,1,3,2,3,1,2
                // over eight consecutive loads of the analysed run, never 0. The
                // producers stamp it now (execWriteFact / execAddAlias in
                // memory-tools.js) and upsertFact() stamps it for any producer that
                // does not, so what reaches this branch is legacy records only and it
                // really does converge to 0 — which is what makes it a migration
                // rather than a per-write cost. Per-record logging is deliberately
                // NOT emitted here — this branch touches the whole store and would
                // bury the moves and demotions below.
                if (fact.category !== cat) { fact.category = cat; report.stamped++; }
                keep.push(fact);
                continue;
            }

            const pair = `${cat}->${target}`;
            report.byPair[pair] = (report.byPair[pair] || 0) + 1;
            if (!databases[target]) databases[target] = createEmptyDatabase(target);
            const dest = databases[target];
            const twinIdx = dest.facts.findIndex(f => f && f.key === fact.key);

            if (twinIdx < 0) {
                fact.category = target;
                dest.facts.push(fact);
                dest.updatedAt = Date.now();
                report.moved++;
                sample('MOVED', { key: fact.key, from: cat, to: target });
                addDebugLog('info', `Category convergence: moved ${cat}/${fact.key} → ${target} (no record under that key there)`, {
                    subsystem: 'db', event: 'fact.remapped', actor: 'SYSTEM', reason: 'LEGACY_CATEGORY_REMAP',
                    data: { key: fact.key, from: cat, to: target, scope: normalizeScope(fact.scope) || '(none)' },
                    before: cat, after: target,
                });
                continue;
            }

            const twin = dest.facts[twinIdx];
            const ev = duplicateEvidence(fact, twin);

            if (ev.duplicate) {
                // Same key, same knowledge, two categories: the shadow copy the old
                // load-time remap kept re-creating. The destination copy stays hot and
                // this one is cold-tiered WHERE IT STANDS — not moved (that would put
                // two records under one key in `dest`) and not dropped.
                //
                // UNLESS the destination copy is itself already cold. Demoting this one
                // would then retire the KEY, not just a record: nothing under it would
                // reach the sheet, the digest, the premise floor or the lookup block.
                // Something demoted that ONE copy deliberately — the user, a #CONFLICT
                // loser, a #REEVAL drop, coldTierOverflow — and propagating that to the
                // last hot record is a decision nobody made. Leaving both hot is the
                // lesser evil: a visible duplicate the next pass still resolves once
                // either side is un-colded, rather than a fact that silently leaves play.
                if (isColdFact(twin)) {
                    report.alreadyResolved++;
                    sample('DUPLICATE_KEPT_LAST_HOT', { key: fact.key, from: cat, to: target });
                    addDebugLog('info', `Category convergence: kept ${cat}/${fact.key} hot — its twin ${target}/${twin.key} is already cold, and demoting this one would leave no hot record under the key`, {
                        subsystem: 'db', event: 'fact.remapped', actor: 'SYSTEM', reason: 'LAST_HOT_RECORD_KEPT',
                        data: { key: fact.key, from: cat, to: target, twinCold: true },
                    });
                    keep.push(fact);
                    continue;
                }
                const detail = `duplicate of ${target}/${twin.key} — identical value, note, importance, aspect, kind and knownBy${ev.confirmedBySrcId ? '; same srcId confirms one extraction event' : ''}`;
                if (markFactCold(fact, cat, 'DUPLICATE_OF_CANONICAL', detail)) {
                    report.demotedDuplicate++;
                    sample('DUPLICATE_DEMOTED', { key: fact.key, from: cat, to: target, bySrcId: ev.confirmedBySrcId });
                } else {
                    report.alreadyResolved++;
                }
                keep.push(fact);
                continue;
            }

            // Same key, genuinely different content. One of the two has to stop
            // competing for the sheet, but neither is discarded and neither moves.
            //
            // lastUpdated alone decided this before, and lastUpdated is re-stamped by
            // any touch including a note-only edit — so editing a note on the weaker
            // row was enough to delete the stronger one. Importance leads now: it is
            // the field the agent and the user both set deliberately, and it is what
            // the premise floor and the cold-tier protection already read. lastUpdated
            // only breaks a tie, and a full tie demotes the SOURCE copy, so the
            // canonical location keeps the hot row and the outcome is deterministic
            // (which is what makes the second pass a no-op).
            const impFact = clampImportance(fact.importance);
            const impTwin = clampImportance(twin.importance);
            const tsFact = Number(fact.lastUpdated) || 0;
            const tsTwin = Number(twin.lastUpdated) || 0;
            let sourceLoses;
            let why;
            if (impFact !== impTwin) {
                sourceLoses = impFact < impTwin;
                why = `importance ${impFact} vs ${impTwin}`;
            } else if (tsFact !== tsTwin) {
                sourceLoses = tsFact < tsTwin;
                why = 'equal importance, older lastUpdated';
            } else {
                sourceLoses = true;
                why = 'equal importance and lastUpdated, canonical category wins';
            }

            const loser = sourceLoses ? fact : twin;
            const winner = sourceLoses ? twin : fact;
            const loserCat = sourceLoses ? cat : target;
            const winnerRef = sourceLoses ? `${target}/${twin.key}` : `${cat}/${fact.key}`;

            // Same guard as the duplicate branch: if the winner is already cold, this
            // demotion would take the key's last hot record with it. Skip it and say so
            // — the old log line claimed the winner "stays hot" without ever checking.
            if (isColdFact(winner)) {
                report.alreadyResolved++;
                sample('CLASH_KEPT_LAST_HOT', { key: fact.key, from: cat, to: target, why });
                addDebugLog('info', `Category convergence: kept ${loserCat}/${loser.key} hot — ${winnerRef} would have won (${why}) but is already cold, and demoting this one would leave no hot record under the key`, {
                    subsystem: 'db', event: 'fact.remapped', actor: 'SYSTEM', reason: 'LAST_HOT_RECORD_KEPT',
                    data: { key: fact.key, from: cat, to: target, differing: ev.differing, wouldHaveKept: winnerRef, winnerCold: true },
                });
                keep.push(fact);
                continue;
            }

            if (markFactCold(loser, loserCat, 'CATEGORY_CLASH_WEAKER_CLAIM', `same key as ${winnerRef}, different content (${why}, differing: ${ev.differing.join(', ')}) — kept and readable, just out of the hot set`)) {
                report.demotedCollision++;
                // The one branch that takes a distinct observation out of the sheet, so
                // both values go into the normal debug log, not only into the trace.
                addDebugLog('info', `Category convergence: ${loserCat}/${loser.key} cold-tiered, ${winnerRef} stays hot — ${why}`, {
                    subsystem: 'db', event: 'fact.demoted', actor: 'SYSTEM', reason: 'CATEGORY_CLASH_WEAKER_CLAIM',
                    data: {
                        key: fact.key, from: cat, to: target, differing: ev.differing,
                        demoted: `${loserCat}/${loser.key}`, kept: winnerRef,
                        demotedValue: String(loser.value ?? '').slice(0, 200),
                        demotedNote: String(loser.context ?? '').slice(0, 200),
                    },
                });
                sample('CLASH_DEMOTED', {
                    key: fact.key, from: cat, to: target, why,
                    demoted: `${loserCat}/${loser.key}`, kept: winnerRef,
                    incomingValue: fact.value, incumbentValue: twin.value,
                });
            } else {
                report.alreadyResolved++;
            }
            keep.push(fact);
        }

        if (keep.length !== db.facts.length) {
            db.facts = keep;
            db.updatedAt = Date.now();
            if (keep.length === 0) report.emptied.push(cat);
        }
    }

    // An emptied category is dropped outright rather than left as an empty shell:
    // snapshotAvatar() skips zero-fact categories, so leaving one behind would keep
    // its stale attachment file alive past reconcileDeletedAttachments(). Only the
    // move branch can empty a category now — a demoted record stays in its own
    // category, which is what keeps it findable in the DB panel.
    for (const cat of report.emptied) delete databases[cat];

    report.changed = (report.moved + report.demotedDuplicate + report.demotedCollision + report.stamped) > 0;
    return report;
}

// Persist what canonicalizeCategories() decided. Without this the pass is just the
// old discarded parse with better bookkeeping.
async function persistCanonicalization(avatar, databases, report) {
    // Summary only. Every record this pass moved or demoted already emitted its own
    // 'info' line above (and markFactCold() emitted a second one carrying the
    // salience it was demoted at), so the normal debug log — no test-run recording,
    // no trace — is enough to reconstruct exactly what happened to the store. The
    // trace below adds the sampled before/after values on top of that, not instead.
    addDebugLog('info', `Category convergence: ${report.moved} moved, ${report.demotedDuplicate} duplicate(s) cold-tiered, ${report.demotedCollision} key clash(es) cold-tiered, ${report.stamped} stamped, ${report.alreadyResolved} already resolved — nothing was deleted`, {
        subsystem: 'db', event: 'db.converged', actor: 'SYSTEM', reason: 'LEGACY_CATEGORY_REMAP',
        data: {
            avatar, moved: report.moved, demotedDuplicate: report.demotedDuplicate,
            demotedCollision: report.demotedCollision, alreadyResolved: report.alreadyResolved,
            stamped: report.stamped, emptiedCategories: report.emptied, byPair: report.byPair,
        },
    });
    traceCapture('db.converged', () => ({
        moved: report.moved, demotedDuplicate: report.demotedDuplicate,
        demotedCollision: report.demotedCollision, alreadyResolved: report.alreadyResolved,
        stamped: report.stamped, emptiedCategories: report.emptied, byPair: report.byPair,
        samples: report.samples,
    }), { reason: 'LEGACY_CATEGORY_REMAP' });

    if (!idbAvailable()) {
        // Attachment-only mode. The in-memory map is clean for this session and the
        // cleaned categories reach disk on their next saveDatabase() (the cache hands
        // out these very objects), but the pass will run again on the next cold load.
        addDebugLog('debug', 'Category convergence not persisted — attachment-only mode, will re-run on next load', {
            subsystem: 'db', event: 'db.converged', reason: 'IDB_UNAVAILABLE', data: { avatar },
        });
        return;
    }
    try {
        await idbUpdateRecord(avatar, (rec) => ({
            databases,
            updatedAt: Date.now(),
            deletedCategories: (rec && rec.deletedCategories) || undefined,
        }));
        scheduleSnapshot(avatar);
    } catch (e) {
        // Non-fatal: this session still sees the clean map, the next load retries.
        addDebugLog('fail', `Category convergence could not be persisted — the remap will re-run next load (${e?.message || e})`, {
            subsystem: 'db', event: 'db.converged', reason: 'IDB_WRITE_FAILED', data: { avatar },
        });
    }
}

async function loadAllDatabases(avatar) {
    const databases = await loadAllDatabasesRaw(avatar);
    if (!avatar) return databases;
    const report = canonicalizeCategories(databases);
    if (report.changed) await persistCanonicalization(avatar, databases, report);
    return databases;
}

async function loadAllDatabasesRaw(avatar) {
    if (!avatar) return {};

    const stripLegacyEmbeddings = (map) => {
        for (const db of Object.values(map || {})) {
            for (const fact of (db?.facts || [])) delete fact.embedding;
        }
        return map;
    };

    if (!idbAvailable()) {
        return loadAllDatabasesFromAttachments(avatar);
    }

    try {
        const rec = await idbGetRecord(avatar);
        const idbStamp = rec ? (Number(rec.updatedAt) || 0) : -1; 
        const idbHasData = !!(rec && rec.databases && Object.keys(rec.databases).length > 0);

        const attachMeta = { deletedCategories: {} };
        const attachMap = await loadAllDatabasesFromAttachments(avatar, attachMeta);
        const attachTombs = attachMeta.deletedCategories || {};
        const attachStamp = attachmentSnapshotStamp(avatar, attachMap);
        const attachHasData = Object.keys(attachMap).some(c => (attachMap[c]?.facts || []).length > 0);

        const countCats = (m) => (m && typeof m === 'object') ? Object.keys(m).length : 0;
        const countFacts = (m) => {
            if (!m || typeof m !== 'object') return 0;
            let n = 0;
            for (const k of Object.keys(m)) n += (m[k]?.facts || []).length;
            return n;
        };
        const idbDatabases = (rec && rec.databases) ? rec.databases : {};

        if (idbStamp < 0 && attachHasData) {

            await idbPutDatabases(avatar, attachMap, attachStamp || Date.now(), attachTombs);
            addDebugLog('info', 'Migrated legacy attachment DBs into IndexedDB', {
                subsystem: 'db', event: 'db.migrated', data: {
                    categories: Object.keys(attachMap).length,
                    avatar,
                    attachStamp, idbStamp,

                    categoriesBefore: countCats(idbDatabases), factsBefore: countFacts(idbDatabases),
                    categoriesAfter: countCats(attachMap), factsAfter: countFacts(attachMap),
                },
            });
            return attachMap;
        }

        if (attachHasData && attachStamp > idbStamp) {

            const mergedTombs = mergeTombstones(rec && rec.deletedCategories, attachTombs);
            const relocatedCats = []; // shrank, but every missing key resurfaced elsewhere
            // Value guard FIRST, key guard second: the clobber guard below can only
            // see keys the snapshot LOST, so before any adoption path runs, every
            // key held on both sides keeps whichever copy has the newer per-fact
            // lastUpdated. attachMap is replaced, not mutated — the guard's
            // unrelocatedKeys() checks key presence only, which the value merge
            // never changes.
            const valueGuard = idbHasData
                ? mergeNewerLocalFacts(attachMap, idbDatabases)
                : { map: attachMap, keptByCat: {}, keptCount: 0 };
            const attachAdopt = valueGuard.map;
            if (idbHasData) {

                const categoryRecency = (sdb) => {
                    let max = Number(sdb?.updatedAt) || 0;
                    for (const f of (sdb?.facts || [])) {
                        const u = Number(f?.lastUpdated) || 0;
                        if (u > max) max = u;
                    }
                    return max;
                };
                const refusedCats = [];
                const adoptedDeletes = [];
                const missingByCat = {};
                for (const [cat, sdb] of Object.entries(idbDatabases)) {
                    const localFacts = (sdb && Array.isArray(sdb.facts)) ? sdb.facts : [];
                    const localCount = localFacts.length;
                    if (localCount === 0) continue;
                    const attachCount = (attachMap[cat] && Array.isArray(attachMap[cat].facts)) ? attachMap[cat].facts.length : 0;
                    if (attachCount >= localCount) continue;

                    // A shrinking category is NOT automatically loss. The parser applies
                    // mapLegacyCategory() as it reads, so a fact can legitimately leave
                    // `cat` and land in another category of the SAME snapshot. Counting
                    // rows is what kept the World→Places remap alive for 15 consecutive
                    // runs: the guard restored the exact 8 facts the parse had just moved,
                    // which is why refusedCategories read ["World"] every single time.
                    // Only keys with no landing site anywhere in the snapshot are missing.
                    const missing = unrelocatedKeys(cat, localFacts, attachMap);
                    if (missing.length === 0) { relocatedCats.push(cat); continue; }

                    missingByCat[cat] = missing.slice(0, 8);
                    const tomb = Number(attachTombs[cat]) || 0;
                    if (tomb > categoryRecency(sdb)) adoptedDeletes.push(cat);
                    else refusedCats.push(cat);
                }
                if (refusedCats.length > 0) {

                    const merged = { ...attachAdopt };
                    for (const cat of refusedCats) merged[cat] = idbDatabases[cat];
                    await idbPutDatabases(avatar, merged, attachStamp, mergedTombs);
                    addDebugLog('info', 'Rehydrate partially refused: kept local categories the snapshot would SHRINK (clobber guard)', {
                        subsystem: 'db', event: 'db.rehydrated', actor: 'SYSTEM', reason: 'CLOBBER_GUARD',
                        data: {
                            attachStamp, idbStamp, avatar, decision: 'PARTIAL_ADOPT',
                            refusedCategories: refusedCats, tombstoneDeletes: adoptedDeletes,
                            relocatedCategories: relocatedCats, missingKeys: missingByCat,
                            valueGuardKept: valueGuard.keptCount, valueGuardKeys: valueGuard.keptByCat,

                            categoriesBefore: countCats(idbDatabases), factsBefore: countFacts(idbDatabases),
                            categoriesAfter: countCats(merged), factsAfter: countFacts(merged),
                        },
                    });
                    return stripLegacyEmbeddings(merged);
                }
                if (adoptedDeletes.length > 0) {
                    addDebugLog('info', 'Rehydrate adopting tombstoned category delete(s) from newer snapshot', {
                        subsystem: 'db', event: 'db.rehydrated', actor: 'SYSTEM', reason: 'TOMBSTONE_DELETE',
                        data: { attachStamp, idbStamp, avatar, tombstoneDeletes: adoptedDeletes },
                    });
                }
            }
            await idbPutDatabases(avatar, attachAdopt, attachStamp, mergedTombs);
            addDebugLog('info', 'Rehydrated IndexedDB from newer attachment snapshot', {
                subsystem: 'db', event: 'db.rehydrated', actor: 'SYSTEM', reason: 'NEWER_SNAPSHOT',
                data: {
                    attachStamp, idbStamp, avatar, decision: 'ADOPT_ATTACHMENT',
                    relocatedCategories: relocatedCats,
                    valueGuardKept: valueGuard.keptCount, valueGuardKeys: valueGuard.keptByCat,

                    categoriesBefore: countCats(idbDatabases), factsBefore: countFacts(idbDatabases),
                    categoriesAfter: countCats(attachAdopt), factsAfter: countFacts(attachAdopt),
                },
            });
            return attachAdopt;
        }

        if (idbHasData) return stripLegacyEmbeddings(rec.databases);
        return {};
    } catch (e) {

        console.error('[BFMemory] IDB load failed; falling back to attachments', e);
        disableIdb('IDB load failed mid-session'); 
        return loadAllDatabasesFromAttachments(avatar);
    }
}

// Which of `cat`'s local keys the incoming snapshot genuinely does not hold anywhere.
// A key still in `cat`, or sitting in the category mapLegacyCategory() would send it
// to, is accounted for. Key equality is the right test here: the parser moves the
// fact OBJECT, so a hit in the destination IS this record, not a namesake.
function unrelocatedKeys(cat, localFacts, attachMap) {
    const missing = [];
    const stillHere = new Set(((attachMap[cat] && attachMap[cat].facts) || []).map(f => f && f.key));
    for (const f of localFacts) {
        if (!f || typeof f !== 'object') continue;
        if (stillHere.has(f.key)) continue;
        const target = mapLegacyCategory(cat, f);
        const dest = (target && target !== cat) ? attachMap[target] : null;
        if (dest && Array.isArray(dest.facts) && dest.facts.some(x => x && x.key === f.key)) continue;
        missing.push(f.key);
    }
    return missing;
}

// Value-level companion to the clobber guard above. That guard catches keys the
// snapshot LOST; it is blind to a key that exists on both sides where the
// snapshot holds an OLDER value. attachmentSnapshotStamp() dates the attachment,
// not its content, so a snapshot serialized moments before an agent save but
// stamped after it adopts cleanly and silently rolls the value back — observed
// in the v0.81.0 test run, where a reflection update to a Relationships fact was
// reverted three seconds after it was written and the rollback persisted for the
// rest of the session. Per-fact `lastUpdated` is the only content-derived clock
// available, so on a key collision the newer side wins; a tie keeps the
// snapshot's copy (the pre-existing behaviour). Keys on one side only are left
// exactly as the key-level guard decides — this merge never adds or removes a
// key, so unrelocatedKeys() sees the same key sets either way.
function mergeNewerLocalFacts(attachMap, idbDatabases) {
    const keptByCat = {};
    let keptCount = 0;
    let merged = attachMap;
    for (const [cat, sdb] of Object.entries(idbDatabases || {})) {
        const localFacts = (sdb && Array.isArray(sdb.facts)) ? sdb.facts : [];
        if (localFacts.length === 0) continue;
        const adb = merged[cat];
        const attachFacts = (adb && Array.isArray(adb.facts)) ? adb.facts : null;
        if (!attachFacts || attachFacts.length === 0) continue;
        let indexByKey = null;
        for (const lf of localFacts) {
            if (!lf || typeof lf !== 'object' || !lf.key) continue;
            if (indexByKey === null) {
                indexByKey = new Map();
                attachFacts.forEach((af, i) => { if (af && af.key) indexByKey.set(af.key, i); });
            }
            const idx = indexByKey.get(lf.key);
            if (idx === undefined) continue;
            if ((Number(lf.lastUpdated) || 0) <= (Number(attachFacts[idx]?.lastUpdated) || 0)) continue;
            // Copy-on-first-win so callers holding attachMap never see a mutation.
            if (merged === attachMap) merged = { ...attachMap };
            if (merged[cat] === adb) merged[cat] = { ...adb, facts: adb.facts.slice() };
            merged[cat].facts[idx] = lf;
            (keptByCat[cat] = keptByCat[cat] || []).push(lf.key);
            keptCount++;
        }
    }
    if (keptCount > 0) {
        addDebugLog('info', `Rehydrate value guard: kept ${keptCount} newer local fact value(s) a same-key snapshot row would have rolled back`, {
            subsystem: 'db', event: 'db.rehydrated', actor: 'SYSTEM', reason: 'VALUE_GUARD',
            data: { keptByCat },
        });
    }
    return { map: merged, keptByCat, keptCount };
}

function attachmentSnapshotStamp(avatar, parsedMap) {
    let max = 0;
    let sawEmbeddedStamp = false;
    for (const db of Object.values(parsedMap || {})) {
        const u = Number(db?.updatedAt) || 0;
        if (u > 0) sawEmbeddedStamp = true;
        if (u > max) max = u;
    }

    if (!sawEmbeddedStamp) {
        try {
            const context = getContext();
            const attachments = context.extensionSettings?.character_attachments?.[avatar] || [];
            for (const a of attachments) {
                if (!a.name?.startsWith(DB_PREFIX)) continue;
                const c = Number(a.created) || 0;
                if (c > max) max = c;
            }
        } catch {  }
    }
    return max;
}

async function loadAllDatabasesFromAttachments(avatar, meta) {
    if (!avatar) return {};

    const context = getContext();
    const attachments = context.extensionSettings?.character_attachments?.[avatar] || [];

    const databases = {};
    for (const attachment of attachments) {
        if (!attachment.name?.startsWith(DB_PREFIX)) continue;

        try {
            const content = await fetchAttachmentContent(attachment.url);
            if (content) {
                const db = JSON.parse(content);

                if (meta && db.deletedCategories && typeof db.deletedCategories === 'object'
                    && !Array.isArray(db.deletedCategories)) {
                    if (!meta.deletedCategories) meta.deletedCategories = {};
                    for (const [cat, ts] of Object.entries(db.deletedCategories)) {
                        const t = Number(ts) || 0;
                        if (t > (Number(meta.deletedCategories[cat]) || 0)) meta.deletedCategories[cat] = t;
                    }
                }

                for (const fact of (db.facts || [])) {
                    delete fact.embedding; 
                    const target = mapLegacyCategory(db.category, fact);

                    if (target !== db.category) {
                        addDebugLog('debug', `Legacy category remap: ${db.category} → ${target} (${fact.key})`, {
                            subsystem: 'db', event: 'fact.remapped', reason: 'LEGACY_CATEGORY_REMAP',
                            data: { key: fact.key }, before: db.category, after: target,
                        });
                    }
                    fact.category = target;
                    if (!databases[target]) databases[target] = createEmptyDatabase(target);

                    const dupIdx = databases[target].facts.findIndex(f => f && f.key === fact.key);
                    if (dupIdx >= 0) {
                        const incumbent = databases[target].facts[dupIdx];
                        if ((Number(fact.lastUpdated) || 0) > (Number(incumbent.lastUpdated) || 0)) {
                            databases[target].facts[dupIdx] = fact; 
                        }
                        continue;
                    }
                    databases[target].facts.push(fact);

                    if (Number(db.createdAt) && (!databases[target].createdAt || db.createdAt < databases[target].createdAt)) {
                        databases[target].createdAt = db.createdAt;
                    }
                }

                if (!(db.facts || []).length) {
                    const target = mapLegacyCategory(db.category);
                    if (!databases[target]) databases[target] = createEmptyDatabase(target);
                }
            }
        } catch (e) {
            console.error(`[BFMemory] Failed to load DB: ${attachment.name}`, e);
        }
    }

    return databases;
}

// The rows this category may demote at all. Importance 5, sequence rows and
// open threads are exempt outright, so they are neither counted against the
// budget nor eligible to go cold.
function demotableFacts(db) {
    const out = [];
    if (!db || !Array.isArray(db.facts)) return out;
    for (const f of db.facts) {
        if (!f || typeof f !== 'object') continue;
        if (!isActiveFact(f)) continue;
        if (isSequenceFact(f)) continue;
        if (f.thread === 'open') continue;
        if (clampImportance(f.importance) >= COLD_TIER_PROTECT_IMPORTANCE) continue;
        out.push(f);
    }
    return out;
}

// Returns the number of currently-cold rows this category would RELEASE under
// `budget` — i.e. how far the stored cold flags lag the setting in force. Pure:
// it is what the cost readout reports as `excluded.coldReleasable`, and it must
// not mutate anything on a path the settings UI calls per slider pixel.
function coldReleasableCount(db, budget) {
    const demotable = demotableFacts(db);
    const coldNow = demotable.filter(f => f.cold === true).length;
    if (coldNow === 0) return 0;
    if (demotable.length <= budget) return coldNow;
    const stayCold = demotable.length - budget;
    return Math.max(0, coldNow - stayCold);
}

// Returns true when anything changed, so callers can persist selectively.
function coldTierOverflow(db) {
    if (!db || !Array.isArray(db.facts)) return false;
    const now = Date.now();
    const budget = hotSetBudget();

    const demotable = demotableFacts(db);

    // Infinity lands here too, and that is the whole UNLIMITED story: the branch
    // that un-colds becomes unconditional, so switching the slider to "no limit"
    // RELEASES every overflow demotion instead of merely halting new ones. A
    // ceiling that only stopped growing would still have been a ceiling.
    //
    // isBudgetCold is what keeps that from also releasing every VERDICT. This pass
    // now runs once per turn across EVERY category (reconcileColdTier), so an
    // unguarded release would give a #CONFLICT loser, a merge loser, a #REEVAL
    // drop and every canonicalisation shadow copy a lifetime of exactly one turn.
    if (demotable.length <= budget) {
        let released = 0;
        for (const f of demotable) {
            if (isBudgetCold(f) && uncoldFact(f, db.category, 'COLD_REACTIVATED', 'hot-set no longer over budget')) released++;
        }
        return released > 0;
    }

    const ranked = demotable.slice().sort((a, b) => salienceScore(b, now) - salienceScore(a, now));
    const keepHot = ranked.slice(0, budget);
    const goCold = ranked.slice(budget);

    let changed = false;
    for (const f of keepHot) {
        // Same rule: rising back up the salience ranking earns a BUDGET row its
        // place back, and earns a judged row nothing.
        if (isBudgetCold(f) && uncoldFact(f, db.category, 'COLD_REACTIVATED', 'rose back into hot set')) changed = true;
    }

    for (const f of goCold) {
        if (f.cold === true) continue;
        f.cold = true;
        f.coldVia = COLD_VIA_BUDGET;
        changed = true;
        addDebugLog('info', `Fact cold-tiered (kept, deprioritized): [${db.category}] ${f.key} (score ${salienceScore(f, now).toFixed(2)}, imp ${clampImportance(f.importance)}, ${normalizeKind(f.kind)})`, {
            subsystem: 'db', event: 'fact.demoted', reason: 'COLD_TIERED_LOW_SALIENCE',
            data: {
                category: db.category, key: f.key,
                salienceScore: Number(salienceScore(f, now).toFixed(3)),
                hotSetBudget: budget,
            },
        });
    }
    return changed;
}

/**
 * Apply the CURRENT hot-set budget to every category at once.
 *
 * saveDatabase() cold-tiers only the category it is writing, which is correct
 * for a data change but not for a SETTING change: move the premise-floor slider
 * and a category nothing writes keeps a cold set sized for the old number
 * indefinitely — so the cost readout would keep reporting rows as unreachable
 * that the new setting has already paid for. This is the reconciler for that
 * case. Call it after a slider commit, and once per turn before the sheet is
 * composed.
 *
 * Never throws: a failure here leaves the previous flags standing, which is the
 * status quo, not a new failure.
 * @param {object} [opts]
 * @param {boolean} [opts.persist=true] false = reconcile the cached objects only.
 * @returns {Promise<{categories:string[], budget:number}>}
 */
export async function reconcileColdTier({ persist = true } = {}) {
    const out = { categories: [], budget: hotSetBudget() };
    try {
        const avatar = getCharacterAvatar();
        if (!avatar) return out;
        const databases = await getAllDatabases();
        const touched = [];
        for (const [category, db] of Object.entries(databases || {})) {
            if (coldTierOverflow(db)) touched.push(category);
        }
        out.categories = touched;
        if (touched.length === 0) return out;

        addDebugLog('info', `Cold tier reconciled against the premise-floor setting — ${touched.length} categor${touched.length === 1 ? 'y' : 'ies'} changed (budget ${Number.isFinite(out.budget) ? out.budget : 'UNLIMITED'})`, {
            subsystem: 'db', event: 'fact.demoted', reason: 'COLD_TIER_RECONCILED',
            data: { categories: touched, budget: Number.isFinite(out.budget) ? out.budget : null },
        });

        if (!persist || !idbAvailable()) return out;
        await idbUpdateRecord(avatar, (rec) => {
            const next = (rec && rec.databases) ? rec.databases : {};
            for (const cat of touched) { if (databases[cat]) next[cat] = databases[cat]; }
            return {
                databases: next,
                updatedAt: Date.now(),
                deletedCategories: (rec && rec.deletedCategories) || undefined,
            };
        });
        scheduleSnapshot(avatar);
        return out;
    } catch (e) {
        addDebugLog('fail', `Cold-tier reconciliation failed (non-fatal): ${e?.message || e}`, {
            subsystem: 'db', event: 'fact.demoted', reason: 'COLD_TIER_RECONCILE_FAILED',
        });
        return out;
    }
}

/**
 * Per-category exclusion counts for the premise-floor cost readout.
 * Pure — no writes, safe to call per slider repaint.
 * @returns {{cold:number, coldReleasable:number, budget:number}}
 */
export function coldTierCensus(databases) {
    const budget = hotSetBudget();
    let cold = 0;
    let coldReleasable = 0;
    for (const db of Object.values(databases || {})) {
        if (!db || !Array.isArray(db.facts)) continue;
        for (const f of db.facts) {
            if (f && isActiveFact(f) && f.cold === true) cold++;
        }
        coldReleasable += coldReleasableCount(db, budget);
    }
    return { cold, coldReleasable, budget };
}

export async function saveDatabase(db) {
    const avatar = getCharacterAvatar();
    if (!avatar) throw new Error('No character selected');

    invalidateDatabaseCache();

    coldTierOverflow(db);

    if (idbAvailable()) {
        try {

            await idbUpdateRecord(avatar, (rec) => {
                const databases = (rec && rec.databases) ? rec.databases : {};
                databases[db.category] = db;

                const tombs = { ...((rec && rec.deletedCategories) || {}) };
                delete tombs[db.category];
                return { databases, updatedAt: Date.now(), deletedCategories: tombs };
            });

            scheduleSnapshot(avatar);
            return;
        } catch (e) {

            console.error('[BFMemory] IDB save failed; falling back to attachment write', e);
            disableIdb('IDB save failed mid-session');
        }
    }

    await saveDatabaseToAttachment(avatar, db);
}

// ===========================================================================
// DEMAND vs SUPPLY — why one injected sheet produces two different writes.
//
// useCount / lastUsedAt are READ in two places that decide what survives:
// salienceScore() folds useBonus(useCount) into the score, and effectiveRecencyTs()
// takes max(lastUpdated, lastUsedAt) as the recency term. Both feed coldTierOverflow().
// Nothing ever WROTE them — all 64 facts in the analysed run sat at 0/0, so
// effectiveRecencyTs collapsed to lastUpdated and a fact injected on every single
// turn cooled out of the hot set at exactly the rate of one never injected at all.
//
// This is that missing write side. Deliberately NOT saveDatabase(): the injection
// path calls it once per turn with ~26 refs spread over ~5 categories, and
// saveDatabase() would re-run cold-tiering, drop the read cache and issue a separate
// write per category. Instead the cached fact objects are bumped in place — the map
// getAllDatabases() returns holds the same object identities the store does — and the
// touched categories go back in ONE IndexedDB transaction.
//
// THE RATCHET THIS SPLIT EXISTS FOR. Crediting every injected row as USE was
// sound while the premise floor was 15 rows out of 65. It stops being sound the
// moment the floor is large: then nearly every hot fact is on every sheet, so
// every hot fact gets lastUsedAt = now every turn, ageDays goes to ~0 for all of
// them, and RECENCY_WEIGHT * recency becomes a CONSTANT. useBonus saturates at
// USE_BONUS_CAP for everyone for the same reason. salienceScore degenerates to
// importance — and salienceScore is precisely the ranking coldTierOverflow uses
// to decide who gets demoted, so the demotion becomes a bare importance cut with
// no usage evidence in it. Worse, it is one-directional: a fact that once fell
// out of the hot set is no longer injected, so it is no longer refreshed, while
// every fact still inside is refreshed every single turn. It can never climb
// back. That is the same disappearance the floor slider was raised to fix, one
// layer down.
//
// SO: does a fact "count as used" when it rode in on the FLOOR? No. It was not
// selected for this turn — it is furniture; it is on the sheet because the
// setting says so, not because anything about this turn wanted it. Counting it
// measures the slider, not the fact. Same for the random-walk extras, which are
// a serendipity injection nobody asked for. What DOES count is demand: the
// agent's NEED picks, the sticky recovered refs (recovered precisely because a
// reply fumbled them), and anything the lookup pass appended to the sheet.
//
//   DEMAND -> useCount++, lastUsedAt = at   (feeds recency and the use bonus)
//   SUPPLY -> seenCount++, lastSeenAt = at  (feeds NOTHING in salienceScore)
//
// `seenCount` is recorded rather than discarded because it is the denominator
// the hit-rate question needs ("of the turns this fact was available, how often
// was it reached for") and because a row with a large seenCount and a zero
// useCount is a concrete, readable answer to "why did this get demoted".
// Nothing scores on it today; adding it to salienceScore would be a second
// ranking change in the same pass.
//
// PRE-EXISTING COUNTERS are left alone. Stores written before this split carry
// useCount values inflated by blanket crediting; useBonus is log1p-shaped and
// capped at 0.20, so the inflation compresses to near-nothing and washes out as
// real demand accrues. Not worth a migration.
//
// `lastUpdated` is left alone on purpose: it means "the content changed", it is what
// the sheet renders as "(~16 turns ago)", and reading a fact is not a change to it.

// The supply half of the sheet that is currently injected, published by
// composeSheet (agent-memory.js) as it builds it — the only place that still
// knows which rows came from the floor and which the agent asked for, since the
// flush downstream sees nothing but ref text parsed back out of the rendered
// sheet.
//
// ORDERING IS SAFE, not assumed: the flush runs at MESSAGE_RECEIVED and the
// next composeSheet runs after it, in the same continuation
// (flushInjectedFactUsage -> runMemoryExtraction in pipeline.js), so the record
// standing at flush time always describes the sheet that was just injected.
// Stamped with chat + character anyway and ignored on a mismatch, because a
// switch between the two would otherwise apply one chat's provenance to
// another's facts.
//
// UNSET means unknown, and unknown is credited as DEMAND — i.e. exactly the old
// behaviour. That is the state after a page reload, for the one turn before the
// first sheet is composed, and it is the safe direction: over-crediting one turn
// blurs the ranking slightly, whereas under-crediting would silently discard a
// real NEED hit.
let sheetSupplyRefs = null; // { ids: Set<string>, avatar, chatId }

/**
 * Publish which of the sheet's rows were SUPPLY (premise floor + connected
 * memories) rather than demand. Called by composeSheet; nothing else should.
 * @param {Iterable<{category:string,key:string}>} rows
 */
export function setSheetSupplyRefs(rows) {
    try {
        const ids = new Set();
        for (const r of (rows || [])) {
            const category = String(r?.category || '').trim();
            const key = String(r?.key || '').trim();
            if (category && key) ids.add(`${category}/${key}`.toLowerCase());
        }
        sheetSupplyRefs = {
            ids,
            avatar: getCharacterAvatar() || '',
            chatId: getCurrentChatIdSafe(),
        };
    } catch {
        sheetSupplyRefs = null;
    }
}

function supplyRefIds(avatar) {
    const rec = sheetSupplyRefs;
    if (!rec) return null;
    if (rec.avatar && avatar && rec.avatar !== avatar) return null;
    const live = getCurrentChatIdSafe();
    if (rec.chatId && live && rec.chatId !== live) return null;
    return rec.ids;
}

/**
 * Record that a set of facts was injected this turn, split into demand and supply.
 * @param {Iterable<{category: string, key: string}|string>} refs  Facts to bump.
 *        Objects, or "Category/key" strings — the ref form the retrieval and
 *        recovery paths already speak. Duplicates within one call count once.
 * @param {object} [opts]
 * @param {number} [opts.at=Date.now()]      Timestamp written to lastUsedAt/lastSeenAt.
 * @param {string} [opts.reason='INJECTED']  Why, for the log/trace.
 * @param {boolean} [opts.persist=true]      false = bump in memory only.
 * @returns {Promise<{bumped:number, seen:number, missed:number, categories:string[], at:number}>}
 *          `bumped` counts DEMAND rows (the ones that moved salience); `seen`
 *          counts supply rows. Never throws and never rejects: usage accounting
 *          must not be able to take a turn down.
 */
export async function recordFactUsage(refs, opts = {}) {
    const at = Math.max(0, Math.floor(Number(opts.at) || Date.now()));
    const reason = opts.reason || 'INJECTED';
    const persist = opts.persist !== false;
    const result = { bumped: 0, seen: 0, missed: 0, categories: [], at };

    try {
        const list = (refs && typeof refs[Symbol.iterator] === 'function' && typeof refs !== 'string')
            ? Array.from(refs) : [];
        if (list.length === 0) return result;

        const avatar = getCharacterAvatar();
        if (!avatar) return result;

        const databases = await getAllDatabases();
        const seen = new Set();
        // Deduped on the RESOLVED fact, not on the ref text: findFactMatch() also
        // answers on a normalized key and on a reversed pair key, so two different-
        // looking refs in one selection can be the same record. Counting that twice
        // would inflate exactly the facts the retrieval path is loosest about.
        const bumped = new Set();
        const touched = new Set();
        const missedRefs = [];
        // null = no provenance for this sheet, so every row is credited as
        // demand (the pre-split behaviour). See the block comment above.
        const supply = supplyRefIds(avatar);

        for (const raw of list) {
            let category = '';
            let key = '';
            if (raw && typeof raw === 'object') {
                category = String(raw.category || '').trim();
                key = String(raw.key || '').trim();
            } else {
                const s = String(raw ?? '').trim();
                const slash = s.indexOf('/');
                if (slash > 0) { category = s.slice(0, slash).trim(); key = s.slice(slash + 1).trim(); }
            }
            if (!category || !key) {
                result.missed++;
                if (missedRefs.length < 8) missedRefs.push(String(raw));
                continue;
            }
            const id = `${category}/${key}`;
            if (seen.has(id)) continue; // identical ref repeated — not even worth resolving
            seen.add(id);

            const db = databases[category];
            const fact = db ? findFactMatch(db, key) : null;
            if (!fact) {
                result.missed++;
                if (missedRefs.length < 8) missedRefs.push(id);
                continue;
            }
            if (bumped.has(fact)) continue; // a second ref onto a record already counted
            bumped.add(fact);

            // Matched on the ref as RENDERED, not on the resolved record:
            // composeSheet publishes the same `${category}/${fact.key}` string
            // buildFactLine printed and extractSheetFactRefs read back, so the
            // two sides are the same text by construction. Resolving first and
            // matching on the record would reintroduce findFactMatch's fuzzy
            // key mapping in the one place it must not apply.
            if (supply && supply.has(id.toLowerCase())) {
                fact.seenCount = Math.max(0, Math.floor(Number(fact.seenCount) || 0)) + 1;
                fact.lastSeenAt = at;
                result.seen++;
            } else {
                fact.useCount = Math.max(0, Math.floor(Number(fact.useCount) || 0)) + 1;
                fact.lastUsedAt = at;
                result.bumped++;
            }
            touched.add(category);
        }
        result.categories = [...touched];

        addDebugLog('debug', `Fact usage recorded: ${result.bumped} used (demand), ${result.seen} seen (floor/extras, salience unchanged), ${result.missed} unresolved (${reason})`, {
            subsystem: 'db', event: 'fact.used', reason,
            data: {
                bumped: result.bumped, seen: result.seen, missed: result.missed,
                provenance: supply ? 'known' : 'unknown-all-demand',
                categories: result.categories, unresolved: missedRefs,
            },
        });
        traceCapture('db.factUsage', () => ({
            reason, at, bumped: result.bumped, seen: result.seen, missed: result.missed,
            provenance: supply ? 'known' : 'unknown-all-demand',
            categories: result.categories, unresolved: missedRefs,
        }), { reason });

        // `seen` counts too: seenCount/lastSeenAt are stored fields, and losing
        // them on a turn that happened to produce no demand hit would make the
        // denominator of the hit rate depend on whether the numerator was zero.
        if ((result.bumped === 0 && result.seen === 0) || !persist) return result;

        if (!idbAvailable()) {
            // Attachment-only mode. The counters are live for this session and reach
            // disk whenever one of these categories is next written for a real reason
            // (the cache hands out these very fact objects). Not worth an upload per
            // category per turn just to persist a counter.
            return result;
        }
        try {
            await idbUpdateRecord(avatar, (rec) => {
                const next = (rec && rec.databases) ? rec.databases : {};
                // Only the touched categories are replaced — everything else in the
                // record is left exactly as another writer left it.
                for (const cat of touched) { if (databases[cat]) next[cat] = databases[cat]; }
                return {
                    databases: next,
                    updatedAt: Date.now(),
                    deletedCategories: (rec && rec.deletedCategories) || undefined,
                };
            });
            scheduleSnapshot(avatar);
        } catch (e) {
            // Non-fatal, and the bumps survive in memory until the next real save.
            addDebugLog('fail', `Fact usage counters not persisted (${e?.message || e})`, {
                subsystem: 'db', event: 'fact.used', reason: 'IDB_WRITE_FAILED',
                data: { bumped: result.bumped, categories: result.categories },
            });
        }
        return result;
    } catch (e) {
        addDebugLog('fail', `recordFactUsage failed (${e?.message || e})`, {
            subsystem: 'db', event: 'fact.used', reason: 'USAGE_RECORD_FAILED',
        });
        return result;
    }
}

async function saveDatabaseToAttachment(avatar, db) {
    const fileName = `${DB_PREFIX}${db.category.toLowerCase().replace(/[^a-z0-9]/g, '_')}.json`;
    const content = JSON.stringify(db, null, 2);
    const base64Data = btoa(unescape(encodeURIComponent(content)));

    const context = getContext();
    const extensionSettings = context.extensionSettings;

    if (!extensionSettings.character_attachments) {
        extensionSettings.character_attachments = {};
    }
    if (!extensionSettings.character_attachments[avatar]) {
        extensionSettings.character_attachments[avatar] = [];
    }

    const attachments = extensionSettings.character_attachments[avatar];

    const { uploadFileAttachment } = await import('../../../../chats.js');
    const uniqueName = `${Date.now()}_${fileName}`;
    const fileUrl = await uploadFileAttachment(uniqueName, base64Data);
    if (!fileUrl) throw new Error('Upload failed');

    const existingIdx = attachments.findIndex(a => a.name === fileName);
    if (existingIdx >= 0) {
        try {
            await deleteAttachmentFile(attachments[existingIdx].url);
        } catch {  }
        attachments.splice(existingIdx, 1);
    }

    attachments.push({
        url: fileUrl,
        size: content.length,
        name: fileName,

        created: Number(db?.updatedAt) || Date.now(),
    });

    if (context.saveSettingsDebounced) {
        context.saveSettingsDebounced();

        if (typeof context.saveSettingsDebounced.flush === 'function') {
            context.saveSettingsDebounced.flush();
        }
    }
}

export async function deleteDatabase(category) {
    const avatar = getCharacterAvatar();
    if (!avatar) return;

    invalidateDatabaseCache();

    cancelPendingSnapshot(avatar);

    if (idbAvailable()) {
        try {
            await idbUpdateRecord(avatar, (rec) => {

                if (!(rec && rec.databases && Object.prototype.hasOwnProperty.call(rec.databases, category))) {
                    return null;
                }
                delete rec.databases[category];

                const tombs = { ...(rec.deletedCategories || {}) };
                tombs[category] = Date.now();
                return { databases: rec.databases, updatedAt: Date.now(), deletedCategories: tombs };
            });
        } catch (e) {
            console.error('[BFMemory] IDB delete failed; removing attachment only', e);
            disableIdb('IDB delete failed mid-session');
        }
    }

    const context = getContext();
    const attachments = context.extensionSettings?.character_attachments?.[avatar] || [];
    const fileName = `${DB_PREFIX}${category.toLowerCase().replace(/[^a-z0-9]/g, '_')}.json`;

    const idx = attachments.findIndex(a => a.name === fileName);
    if (idx >= 0) {
        try {
            await deleteAttachmentFile(attachments[idx].url);
        } catch {  }
        attachments.splice(idx, 1);
        context.saveSettingsDebounced?.();
    }
}

export function createEmptyDatabase(category) {
    return {
        category,
        facts: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
}

const MAX_SOURCE_HISTORY = 10;

function mergeProvenance(existing, incoming, now) {
    const genesisSource = existing.source || incoming.source || '';
    const genesisValidAt = (existing.validAt !== undefined) ? existing.validAt : incoming.validAt;
    let history = Array.isArray(existing.sourceHistory) ? [...existing.sourceHistory] : [];
    const prevSource = existing.source;
    if (prevSource && incoming.source && prevSource !== incoming.source) {
        history.push({ src: prevSource, at: existing.lastUpdated || now });
        if (history.length > MAX_SOURCE_HISTORY) history.splice(0, history.length - MAX_SOURCE_HISTORY);
    }

    const genesisValidFrom = (existing.validFrom !== undefined) ? existing.validFrom : incoming.validFrom;
    return {
        source: genesisSource,
        validAt: genesisValidAt,
        ...(genesisValidFrom !== undefined ? { validFrom: genesisValidFrom } : {}),
        ...(history.length ? { sourceHistory: history } : {}),
    };
}

export function upsertFact(db, fact) {

    const supersedesSignal = fact && fact.supersedes === true;
    if (fact && 'supersedes' in fact) { fact = { ...fact }; delete fact.supersedes; }

    // Kind is derived here rather than trusted, and here specifically because this
    // is the ONE funnel every writer goes through — memory agent (memory-tools.js),
    // reflect agent (agent-reflect.js) and dedupeDatabase()'s rebuild alike. Doing
    // it per-caller would have left whichever path was forgotten writing 'trait'
    // forever. See deriveKind() for why the model's answer is not enough.
    // Side effect worth stating: because mergeSalience() lets a present incoming
    // kind win over the stored one, every existing fact is re-derived the next time
    // anything touches it — the store heals without a separate migration.
    if (fact && typeof fact === 'object') {
        const passedKind = passedKindOf(fact);
        const derived = deriveKind(fact, db?.category);
        if (derived.kind !== passedKind) {
            // The old line said `agent said "<passedKind>"` unconditionally, and the
            // `if (passedKind)` guard meant it only ever printed when the field was
            // populated — which, until execWriteFact stopped fabricating it, was
            // always, so every one of these lines reported the extension's own
            // DEFAULT_KIND back as the model's word. Now that "said nothing" reaches
            // here as an empty passedKind, that case is stated as what it is instead
            // of being dropped: the derivation is the only reason the record has a
            // kind at all, and a silent log made that indistinguishable from an
            // override the model lost.
            addDebugLog('debug', passedKind
                ? `Kind derived: [${db?.category}] ${fact.key} — agent said "${passedKind}", stored as "${derived.kind}"`
                : `Kind derived: [${db?.category}] ${fact.key} — agent named no kind, stored as "${derived.kind}"`, {
                subsystem: 'db', event: 'fact.kind_derived', reason: derived.via,
                data: {
                    category: db?.category, key: fact.key,
                    aspect: normalizeAspect(fact.aspect, fact.category || db?.category),
                    passed: passedKind || null, derived: derived.kind,
                    agentNamedKind: !!passedKind,
                },
                before: passedKind || '(none)', after: derived.kind,
            });
            fact = { ...fact, kind: derived.kind };
        }
    }

    // Same funnel argument as the kind derivation above, for the same reason: the
    // producers stamp `category` themselves now, but a producer that forgets one
    // (or a future one that never knew) costs a full-store rewrite plus a snapshot
    // on EVERY subsequent load, because canonicalizeCategories() stamps whatever it
    // finds unstamped and reports changed. Doing it here as well makes convergence
    // a property of the write path rather than a promise each writer has to keep.
    // db.category is authoritative — it is the category the record is being stored
    // in by definition, and it is exactly what canonicalizeCategories() would have
    // written. A record that belongs somewhere else is still MOVED by that pass;
    // this only settles the field for records already in the right place.
    if (fact && typeof fact === 'object' && db?.category && fact.category !== db.category) {
        fact = { ...fact, category: db.category };
    }

    if (isSequenceFact(fact)) {

        let ord = Number(fact.ord);
        if (!Number.isInteger(ord) || ord <= 0) {
            ord = nextOrdForTrack(db, fact.track);
        }
        const seqFact = { ...fact, ord };

        const exactStepIdx = db.facts.findIndex(f =>
            isSequenceFact(f) && f.track === seqFact.track && Number(f.ord) === ord);

        const exactKeyIdx = exactStepIdx >= 0 ? exactStepIdx : db.facts.findIndex(f => f.key === seqFact.key);
        if (exactKeyIdx >= 0) {
            const existing = db.facts[exactKeyIdx];
            const mergedRels = mergeRelationships(existing.relationships, seqFact.relationships);
            const mergedContext = mergeContext(existing.context, seqFact.context);
            const mergedAliases = mergeAliases(existing.aliases, seqFact.aliases);
            const mergedInvolved = mergeInvolved(existing.involved, seqFact.involved);
            const sal = mergeSalience(existing, seqFact);
            const oldSeqVal = existing.value;
            db.facts[exactKeyIdx] = { ...existing, ...seqFact, key: existing.key, relationships: mergedRels, context: mergedContext, aliases: mergedAliases, involved: mergedInvolved, ...sal, ...mergeProvenance(existing, seqFact, Date.now()), createdAt: existing.createdAt || new Date().toISOString(), lastUpdated: Date.now() };
            if (!factValuesEqual(oldSeqVal, seqFact.value)) {
                addDebugLog('debug', `Sequence step updated: [${db.category}] ${existing.key} (track ${seqFact.track}, ord ${ord})`, {
                    subsystem: 'db', event: 'fact.updated', reason: 'VALUE_CHANGED',
                    data: { category: db.category, key: existing.key, track: seqFact.track, ord, isSequence: true },
                    before: oldSeqVal, after: seqFact.value,
                });
            }
        } else {
            db.facts.push({ ...seqFact, ...normalizeSalienceFields(seqFact), createdAt: new Date().toISOString(), lastUpdated: Date.now() });
            addDebugLog('debug', `Sequence step added: [${db.category}] ${seqFact.key} (track ${seqFact.track}, ord ${ord})`, {
                subsystem: 'db', event: 'fact.created',
                data: { category: db.category, key: seqFact.key, value: seqFact.value, subject: deriveSubject(seqFact), aspect: deriveAspect(seqFact), track: seqFact.track, ord, isSequence: true },
            });
        }
        db.updatedAt = Date.now();
        return db;
    }

    let existingIdx = db.facts.findIndex(f => f.key === fact.key);

    let matchVia = existingIdx >= 0 ? 'EXACT_KEY' : null;
    if (existingIdx < 0) {
        const normIncoming = normalizeFactKey(fact.key);
        if (normIncoming) {

            existingIdx = db.facts.findIndex(f => !isSequenceFact(f) && normalizeFactKey(f.key) === normIncoming);
            if (existingIdx >= 0) matchVia = 'NORMALIZED_KEY';
        }
    }

    if (existingIdx < 0) {
        const pairMatch = /^([a-z0-9]+)_([a-z0-9]+)_status$/.exec(String(fact.key || '').trim().toLowerCase());
        if (pairMatch && pairMatch[1] !== pairMatch[2]) {
            const reversedKey = `${pairMatch[2]}_${pairMatch[1]}_status`;
            const revIdx = db.facts.findIndex(f => !isSequenceFact(f) && String(f.key || '').trim().toLowerCase() === reversedKey);
            if (revIdx >= 0) {
                existingIdx = revIdx;
                matchVia = 'PAIR_KEY_REVERSED';
                const fromKey = fact.key;
                const stored = db.facts[revIdx];
                fact = { ...fact, key: stored.key, subject: stored.subject || pairMatch[2], involved: [pairMatch[1]] };
                addDebugLog('debug', `Canonicalized reversed pair-status key: [${db.category}] ${fromKey} → ${stored.key}`, {
                    subsystem: 'db', event: 'fact.merged', reason: 'PAIR_KEY_REVERSED',
                    data: { category: db.category, fromKey, intoKey: stored.key },
                });
            }
        }
    }

    // Was gated on the agent having EXPLICITLY said "state"; deriveKind() above now
    // always stamps a kind, so the gate is just the kind itself. Derived states are
    // the point: a second key for a location/mood/goal the store already tracks is
    // exactly the duplicate this merge exists to catch, and the agent almost never
    // labelled those 'state' on its own.
    if (existingIdx < 0 && normalizeKind(fact.kind) === 'state') {
        const parallelIdx = findParallelStateKey(db, fact, -1);
        if (parallelIdx >= 0) {
            existingIdx = parallelIdx;
            matchVia = 'PARALLEL_KEY';

            const fromKey = fact.key;
            const intoKey = db.facts[parallelIdx].key;
            fact = { ...fact, key: intoKey };
            if (fromKey !== intoKey) {
                addDebugLog('debug', `Merged parallel state key: [${db.category}] ${fromKey} → ${intoKey}`, {
                    subsystem: 'db', event: 'fact.merged', reason: 'PARALLEL_KEY_DEDUP',
                    data: { category: db.category, fromKey, intoKey, subject: deriveSubject(fact), aspect: deriveAspect(fact) },
                });
            }
        }
    }
    if (existingIdx >= 0) {
        const existing = db.facts[existingIdx];

        uncoldFact(existing, db.category, 'COLD_REACTIVATED', 'updated/re-mentioned');

        const mergedRels = mergeRelationships(existing.relationships, fact.relationships);

        const mergedContext = mergeContext(existing.context, fact.context);

        const mergedAliases = mergeAliases(existing.aliases, fact.aliases);

        const mergedInvolved = mergeInvolved(existing.involved, fact.involved);

        // agentLinks union like tags/relationships — a plain spread would let
        // the incoming fact's list wholesale replace the stored one, dropping
        // the {ref, category, reason} records the surviving fact still needs
        // (dedupeDatabase re-feeds duplicates through here).
        const mergedAgentLinks = mergeAgentLinks(existing.agentLinks, fact.agentLinks);

        // Tags are a UNION, not a replacement: the agent rarely re-sends tags on an
        // update, and a plain spread would wipe the stored ones with its empty list.
        const mergedTags = Array.from(new Set([
            ...(Array.isArray(existing.tags) ? existing.tags : []),
            ...(Array.isArray(fact.tags) ? fact.tags : []),
        ]));

        const sal = mergeSalience(existing, fact);

        // History snapshots removed (v0.75): a changed fact now overwrites its live
        // record in place instead of leaving an inactive `_superseded` copy that no
        // read path ever surfaced. Any prior state worth keeping is carried forward
        // inside the fact's own note/value by the memory agent (see the prompt's
        // "UPDATING A CHANGED FACT" rule), so history stays visible to the storyteller.
        void supersedesSignal;

        const oldValue = existing.value;
        const updNow = Date.now();
        db.facts[existingIdx] = { ...existing, ...fact, key: existing.key, tags: mergedTags, relationships: mergedRels, context: mergedContext, aliases: mergedAliases, involved: mergedInvolved, ...(mergedAgentLinks ? { agentLinks: mergedAgentLinks } : {}), ...sal, ...mergeProvenance(existing, fact, updNow), createdAt: existing.createdAt || new Date(updNow).toISOString(), lastUpdated: updNow };
        if (factValuesEqual(oldValue, fact.value)) {
            addDebugLog('debug', `Fact unchanged: [${db.category}] ${existing.key}`, {
                subsystem: 'db', event: 'fact.unchanged',
                data: { category: db.category, key: existing.key, via: matchVia },
            });
        } else {
            addDebugLog('info', `Fact updated: [${db.category}] ${existing.key}`, {
                subsystem: 'db', event: 'fact.updated', reason: 'VALUE_CHANGED',
                data: { category: db.category, key: existing.key, subject: deriveSubject(existing), aspect: deriveAspect(existing), via: matchVia },
                before: oldValue, after: fact.value,
            });
        }
    } else {
        db.facts.push({ ...fact, ...normalizeSalienceFields(fact), createdAt: new Date().toISOString(), lastUpdated: Date.now() });
        addDebugLog('info', `Fact created: [${db.category}] ${fact.key}`, {
            subsystem: 'db', event: 'fact.created',
            data: { category: db.category, key: fact.key, value: fact.value, subject: deriveSubject(fact), aspect: deriveAspect(fact) },
        });
    }
    db.updatedAt = Date.now();
    return db;
}

const SUPERSEDED_SUFFIX = '__was';

function makeSupersededKey(db, canonicalKey) {
    const base = `${canonicalKey}${SUPERSEDED_SUFFIX}`;
    let n = 1;
    let key = `${base}${n}`;
    const taken = new Set((db.facts || []).map(f => f.key));
    while (taken.has(key)) { n++; key = `${base}${n}`; }
    return key;
}

function stripSupersededSuffix(key) {
    return String(key || '').replace(new RegExp(`${SUPERSEDED_SUFFIX}\\d*$`), '');
}

const CROSS_KEY_RULES = [
    {
        id: 'death',
        trigger: {
            aspects: new Set(['death', 'death_event']),
            valueAspects: new Set(['status', 'health']),

            valueRx: /(?<!\b(?:almost|nearly|not)\s)\b(dead|died|dies|killed|deceased|slain|perished|passed away)\b/i,
        },

        targetAspects: new Set(['current_location', 'current_activity', 'current_goal', 'companions_present', 'status', 'health']),
    },
    {
        id: 'departure',
        trigger: {
            aspects: new Set(['departure', 'departure_event', 'relocation']),
            valueAspects: new Set(),
            valueRx: null,
        },

        targetAspects: new Set(['current_location', 'current_activity', 'companions_present']),
    },
    {
        id: 'destroyed_lost',
        trigger: {
            aspects: new Set(['lost_status']),
            valueAspects: new Set(['condition_of_item', 'lost_status', 'damage']),
            valueRx: /\b(destroyed|shattered|burned|burnt|melted|disintegrated|lost|missing|gone for good)\b/i,
        },
        targetAspects: new Set(['ownership', 'previous_owner', 'location_of_item', 'hidden_location']),
    },
];

const MAX_CROSS_KEY_INVALIDATIONS = 8;

function aspectInCategory(fact, owningCategory) {
    return normalizeAspect(fact?.aspect, fact?.category || owningCategory);
}

export function applyCrossKeySupersedeRules(databases, fact, category) {

    try {
        if (host.getExtensionSettings()?.crossKeySupersede === false) return [];
    } catch {  }
    if (!fact || !isActiveFact(fact) || isSequenceFact(fact)) return [];

    const aspect = aspectInCategory(fact, category);
    const kind = normalizeKind(fact.kind);
    const value = String(fact.value ?? '');
    const rule = CROSS_KEY_RULES.find(r =>
        r.trigger.aspects.has(aspect) ||
        (r.trigger.valueAspects.has(aspect) && kind === 'state' && r.trigger.valueRx && r.trigger.valueRx.test(value)));
    if (!rule) return [];

    const subj = deriveSubject(fact);
    if (!subj) return [];

    const triggerRef = `${category}/${fact.key}`; 
    const normTrigger = normalizeFactKey(fact.key);
    const now = Date.now();
    const touched = [];
    let invalidated = 0;

    for (const [cat, db] of Object.entries(databases || {})) {
        if (invalidated >= MAX_CROSS_KEY_INVALIDATIONS) break;
        if (!db || !Array.isArray(db.facts)) continue;

        const candidates = db.facts.filter(f =>
            isActiveFact(f) && !isSequenceFact(f)
            && normalizeKind(f.kind) === 'state'
            && deriveSubject(f) === subj
            && rule.targetAspects.has(aspectInCategory(f, cat))
            && normalizeFactKey(f.key) !== normTrigger
            && !factValuesEqual(f.value, fact.value));
        let dbTouched = false;
        for (const target of candidates) {
            if (invalidated >= MAX_CROSS_KEY_INVALIDATIONS) break;
            invalidateFactCrossKey(db, target, triggerRef, rule.id, now);
            invalidated++;
            dbTouched = true;
        }
        if (dbTouched) touched.push(cat);
    }
    return touched;
}

function invalidateFactCrossKey(db, target, triggerRef, ruleId, now) {
    const canonicalKey = target.key;
    const oldValue = target.value;
    const snapshotKey = makeSupersededKey(db, canonicalKey);
    target.key = snapshotKey;
    target.active = false;
    target.supersededAt = now;
    target.supersededBy = triggerRef; 

    const normCanon = normalizeFactKey(canonicalKey);
    db.facts = db.facts.filter(f =>
        !(f.active === false && f !== target && normalizeFactKey(stripSupersededSuffix(f.key)) === normCanon));
    db.updatedAt = now;
    addDebugLog('info', `Fact superseded: [${db.category}] ${canonicalKey} (cross-key rule "${ruleId}", kept as ${snapshotKey})`, {
        subsystem: 'db', event: 'fact.superseded', reason: `CROSS_KEY_RULE:${ruleId}`,
        data: { category: db.category, key: canonicalKey, snapshotKey, trigger: triggerRef, subject: deriveSubject(target), aspect: deriveAspect(target) },
        before: oldValue,
    });
}

export function deriveSubject(fact) {
    if (!fact) return '';

    const explicit = String(fact.subject || '').trim().toLowerCase().replace(/^@/, '').trim();
    if (explicit) return resolveGenericSubjectToken(explicit);
    const key = String(fact.key || '').trim().toLowerCase();
    if (!key) return '';

    if (normalizeScope(fact.scope) === 'place') {
        const tokens = key.split('_').filter(Boolean);
        if (tokens.length >= 2) return tokens[1];
        return tokens[0] || '';
    }
    const us = key.indexOf('_');
    const prefix = us > 0 ? key.slice(0, us) : key;
    return resolveGenericSubjectToken(prefix);
}

const _RESERVED_CHAR_SUBJECT = new Set(['char', '{{char}}', 'character']);
const _RESERVED_USER_SUBJECT = new Set(['user', '{{user}}', 'persona']);

function resolveGenericSubjectToken(token) {

    const t = String(token || '').trim().toLowerCase().replace(/^@/, '').trim();
    if (!t) return '';
    let real = '';
    try {
        if (_RESERVED_CHAR_SUBJECT.has(t)) real = String(host.getCurrentCharacterName() || '').trim();
        else if (_RESERVED_USER_SUBJECT.has(t)) real = String(host.getUserPersonaName() || '').trim();
    } catch {  }
    return real ? real.toLowerCase() : t;
}

const FACET_VERSION_QUALIFIERS = new Set([
    'current', 'latest', 'now', 'change', 'changed', 'update', 'updated', 'new', 'state', 'status', 'prev', 'previous',
]);

function facetTokensOf(fact) {
    const key = String(fact?.key || '').trim().toLowerCase();
    if (!key) return null;
    const subject = deriveSubject(fact);
    let rest = key;
    if (subject && key === subject) return null; 
    if (subject && key.startsWith(subject + '_')) rest = key.slice(subject.length + 1);
    const tokens = rest.split('_').filter(Boolean);
    return tokens.length ? tokens : null;
}

function factAspect(fact) {
    const tokens = facetTokensOf(fact);
    if (!tokens) return '';

    const last = tokens[tokens.length - 1];
    const facetTokens = (tokens.length > 1 && FACET_VERSION_QUALIFIERS.has(last)) ? tokens.slice(0, -1) : tokens;
    return facetTokens.join('');
}

function leadingFacetToken(fact) {
    const tokens = facetTokensOf(fact);
    return tokens ? (tokens[0] || '') : '';
}

function findParallelStateKey(db, incoming, excludeIdx) {
    if (!db || !Array.isArray(db.facts)) return -1;
    if (isSequenceFact(incoming)) return -1;

    if (hasNumericTail(incoming.key)) return -1;
    const incSubject = deriveSubject(incoming);
    if (!incSubject) return -1;
    const incLead = leadingFacetToken(incoming);
    if (!incLead) return -1;
    const incAspect = factAspect(incoming);
    if (!incAspect) return -1;
    for (let i = 0; i < db.facts.length; i++) {
        if (i === excludeIdx) continue;
        const f = db.facts[i];
        if (isSequenceFact(f)) continue;
        if (f.active === false) continue;            
        if (hasNumericTail(f.key)) continue;         
        if (normalizeKind(f.kind) !== 'state') continue; 
        if (deriveSubject(f) !== incSubject) continue;
        if (leadingFacetToken(f) !== incLead) continue;
        if (factAspect(f) !== incAspect) continue;
        return i;
    }
    return -1;
}

function hasNumericTail(key) {
    return /_\d+$/.test(String(key || '').trim().toLowerCase());
}

export function isSequenceFact(fact) {
    return !!(fact && typeof fact.track === 'string' && fact.track.trim());
}

function nextOrdForTrack(db, track) {
    let max = 0;
    for (const f of (db.facts || [])) {
        if (isSequenceFact(f) && f.track === track) {
            const o = Number(f.ord);
            if (Number.isInteger(o) && o > max) max = o;
        }
    }
    return max + 1;
}

function normalizeSalienceFields(fact) {
    const out = {};
    if (fact && fact.importance !== undefined && fact.importance !== null) {
        out.importance = clampImportance(fact.importance);
    }
    if (fact && fact.kind !== undefined && fact.kind !== null && String(fact.kind).trim()) {
        out.kind = normalizeKind(fact.kind);
    }

    out.useCount = Math.max(0, Math.floor(Number(fact?.useCount) || 0));
    out.lastUsedAt = Math.max(0, Math.floor(Number(fact?.lastUsedAt) || 0));
    // Carried alongside, and deliberately NOT folded into the two above: seen
    // means "the floor put it on the sheet", used means "something asked for
    // it". Merging them back together is the ratchet this pair exists to break.
    out.seenCount = Math.max(0, Math.floor(Number(fact?.seenCount) || 0));
    out.lastSeenAt = Math.max(0, Math.floor(Number(fact?.lastSeenAt) || 0));

    const tone = normalizeTone(fact?.tone);
    if (tone) out.tone = tone;
    return out;
}

function mergeSalience(existing, incoming) {
    const out = {};
    const hasIncImp = incoming && incoming.importance !== undefined && incoming.importance !== null;
    const hasExImp = existing && existing.importance !== undefined && existing.importance !== null;
    if (hasIncImp || hasExImp) {
        const inc = hasIncImp ? clampImportance(incoming.importance) : -Infinity;
        const ex = hasExImp ? clampImportance(existing.importance) : -Infinity;
        out.importance = Math.max(inc, ex);
    }
    const incKind = incoming && incoming.kind !== undefined && incoming.kind !== null && String(incoming.kind).trim();
    if (incKind) out.kind = normalizeKind(incoming.kind);
    else if (existing && existing.kind) out.kind = normalizeKind(existing.kind);

    const exUse = Math.max(0, Math.floor(Number(existing?.useCount) || 0));
    const incUse = Math.max(0, Math.floor(Number(incoming?.useCount) || 0));
    out.useCount = Math.max(exUse, incUse);
    const exUsedAt = Math.max(0, Math.floor(Number(existing?.lastUsedAt) || 0));
    const incUsedAt = Math.max(0, Math.floor(Number(incoming?.lastUsedAt) || 0));
    out.lastUsedAt = Math.max(exUsedAt, incUsedAt);
    // Same max-of-both rule as the pair above: a merge must not lose exposure
    // history, or a merged row looks like it was never offered.
    out.seenCount = Math.max(
        Math.max(0, Math.floor(Number(existing?.seenCount) || 0)),
        Math.max(0, Math.floor(Number(incoming?.seenCount) || 0)));
    out.lastSeenAt = Math.max(
        Math.max(0, Math.floor(Number(existing?.lastSeenAt) || 0)),
        Math.max(0, Math.floor(Number(incoming?.lastSeenAt) || 0)));

    const incTone = normalizeTone(incoming?.tone);
    const exTone = normalizeTone(existing?.tone);
    if (incTone) out.tone = incTone;
    else if (exTone) out.tone = exTone;
    return out;
}

function mergeAliases(existing, incoming) {
    const seen = new Set();
    const out = [];
    for (const list of [existing, incoming]) {
        if (!Array.isArray(list)) continue;
        for (const a of list) {
            const s = String(a ?? '').trim();
            if (!s) continue;
            const k = s.toLowerCase();
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(s);
        }
    }
    return out.length ? out : undefined;
}

function mergeInvolved(existing, incoming) {
    const seen = new Set();
    const out = [];
    for (const list of [existing, incoming]) {
        if (!Array.isArray(list)) continue;
        for (const a of list) {
            const s = String(a ?? '').trim();
            if (!s) continue;
            const k = s.toLowerCase();
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(s);
        }
    }
    return out.length ? out : undefined;
}

function mergeContext(existing, incoming) {
    // An EXPLICIT empty string clears the note (the only way to delete one);
    // an absent/undefined incoming note keeps the stored one.
    if (incoming === '') return undefined;
    const inc = (typeof incoming === 'string') ? incoming.trim() : '';
    if (inc) return inc;
    const ex = (typeof existing === 'string') ? existing.trim() : '';
    return ex || undefined;
}

export function findFactMatch(db, key) {
    if (!db || !Array.isArray(db.facts)) return null;
    const exact = db.facts.find(f => f.key === key);
    if (exact) return exact;
    const norm = normalizeFactKey(key);
    if (norm) {
        const normHit = db.facts.find(f => normalizeFactKey(f.key) === norm);
        if (normHit) return normHit;
    }

    const pairMatch = /^([a-z0-9]+)_([a-z0-9]+)_status$/.exec(String(key || '').trim().toLowerCase());
    if (pairMatch && pairMatch[1] !== pairMatch[2]) {
        const reversedKey = `${pairMatch[2]}_${pairMatch[1]}_status`;
        return db.facts.find(f => !isSequenceFact(f) && String(f.key || '').trim().toLowerCase() === reversedKey) || null;
    }
    return null;
}

export function isMaterialFactWrite(db, fact) {
    if (!fact) return false;
    const matched = fact.track
        ? (db?.facts?.find(f => f.key === fact.key) || null)
        : findFactMatch(db, fact.key);
    if (!matched) return true;
    if (!factValuesEqual(matched.value, fact.value)) return true;
    const norm = arr => (Array.isArray(arr) ? arr : [])
        .map(t => String(t).trim().toLowerCase())
        .filter(Boolean)
        .sort();
    // Tags merge as a union on write, so an update is only material when it ADDS
    // a tag the stored fact lacks. An empty incoming list (the common case — the
    // agent rarely re-sends tags) is NOT a change.
    const incoming = norm(fact.tags);
    if (incoming.length === 0) return false;
    const stored = new Set(norm(matched.tags));
    return incoming.some(t => !stored.has(t));
}

function normalizeFactKey(key) {
    let k = String(key || '').toLowerCase().trim();
    if (!k) return '';
    k = k.replace(/[_\-\s]+/g, '');      
    if (k.length > 3 && k.endsWith('s')) k = k.slice(0, -1); 
    return k;
}

// Union of agentLinks entries, deduped by ref+category. Returns undefined when
// neither side carries any so facts from older profiles never gain the field.
function mergeAgentLinks(existing, incoming) {
    const e = Array.isArray(existing) ? existing : [];
    const i = Array.isArray(incoming) ? incoming : [];
    if (e.length === 0 && i.length === 0) return undefined;
    const out = [];
    const seen = new Set();
    for (const l of [...e, ...i]) {
        if (!l || typeof l !== 'object' || !l.ref) continue;
        const id = `${String(l.ref).trim().toLowerCase()}|${String(l.category || '').trim().toLowerCase()}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(l);
    }
    return out.length ? out : undefined;
}

function mergeRelationships(existing, incoming) {
    const result = { primary: [], secondary: [], tertiary: [] };
    for (const tier of ['primary', 'secondary', 'tertiary']) {
        const e = Array.isArray(existing?.[tier]) ? existing[tier] : [];
        const i = Array.isArray(incoming?.[tier]) ? incoming[tier] : [];
        result[tier] = Array.from(new Set([...e, ...i]));
    }
    return result;
}

const AUTOLINK_MAX_PRIMARY = 5;
const AUTOLINK_MAX_SECONDARY = 5;
const AUTOLINK_MIN_TOKEN_OVERLAP = 2; 

function autoLinkRef(fact) {
    return String(fact?.key || '').trim().toLowerCase();
}

export function autoLinkFact(index, fact, category, runId) {
    const empty = { primary: [], secondary: [] };
    if (!index || !fact || typeof fact !== 'object') return empty;
    if (!isActiveFact(fact)) return empty; 
    const selfId = `${category}:${fact.key}`;
    const selfRef = autoLinkRef(fact);

    const admissible = (entry) => {
        const t = entry && entry.fact;
        if (!t || typeof t !== 'object') return false;
        if (`${entry.category}:${t.key}` === selfId) return false; 
        if (!isActiveFact(t)) return false;
        return true;
    };

    const primaryRefs = new Set();
    const addPrimary = (entry) => {
        if (primaryRefs.size >= AUTOLINK_MAX_PRIMARY) return;
        if (!admissible(entry)) return;
        const ref = autoLinkRef(entry.fact);
        if (ref && ref !== selfRef) primaryRefs.add(ref);
    };

    const myLoc = String(fact.location || '').trim().toLowerCase();
    const myInvolved = new Set((Array.isArray(fact.involved) ? fact.involved : [])
        .map(s => String(s ?? '').trim().toLowerCase()).filter(Boolean));
    if (myLoc || myInvolved.size > 0) {
        const structuralSeen = new Set();
        const structuralTokens = new Set();
        if (myLoc) for (const w of wordTokens(myLoc)) structuralTokens.add(w);
        for (const inv of myInvolved) for (const w of wordTokens(inv)) structuralTokens.add(w);
        for (const tok of structuralTokens) {
            if (primaryRefs.size >= AUTOLINK_MAX_PRIMARY) break;
            for (const entry of (index.byToken.get(tok) || [])) {
                if (primaryRefs.size >= AUTOLINK_MAX_PRIMARY) break;
                const id = `${entry.category}:${entry.fact?.key}`;
                if (structuralSeen.has(id)) continue;
                structuralSeen.add(id);
                if (!admissible(entry)) continue;
                const t = entry.fact;
                const tLoc = String(t.location || '').trim().toLowerCase();
                const tInvolved = new Set((Array.isArray(t.involved) ? t.involved : [])
                    .map(s => String(s ?? '').trim().toLowerCase()).filter(Boolean));
                const sharesLoc = !!(myLoc && tLoc && (myLoc === tLoc
                    || myLoc.startsWith(tLoc + '_') || tLoc.startsWith(myLoc + '_')));
                let sharesInvolved = false;
                for (const inv of myInvolved) { if (tInvolved.has(inv)) { sharesInvolved = true; break; } }
                if (sharesLoc || sharesInvolved) addPrimary(entry);
            }
        }
    }

    const secondaryRefs = new Set();
    const addSecondary = (entry) => {
        if (secondaryRefs.size >= AUTOLINK_MAX_SECONDARY) return;
        if (!admissible(entry)) return;
        const ref = autoLinkRef(entry.fact);
        if (!ref || ref === selfRef) return;
        if (primaryRefs.has(ref)) return; 
        secondaryRefs.add(ref);
    };

    const subject = deriveSubject(fact);
    if (subject) {
        for (const entry of (index.bySubject.get(subject) || [])) {
            if (secondaryRefs.size >= AUTOLINK_MAX_SECONDARY) break;
            addSecondary(entry);
        }
    }

    const myTokens = factTokens(fact); 
    if (myTokens.length > 0) {
        const overlap = new Map(); 
        for (const tok of myTokens) {
            for (const entry of (index.byToken.get(tok) || [])) {
                if (!admissible(entry)) continue;
                const id = `${entry.category}:${entry.fact.key}`;
                const rec = overlap.get(id);
                if (rec) rec.count++;
                else overlap.set(id, { entry, count: 1 });
            }
        }
        const ranked = [...overlap.values()]
            .filter(r => r.count >= AUTOLINK_MIN_TOKEN_OVERLAP)
            .sort((a, b) => b.count - a.count);
        for (const { entry } of ranked) {
            if (secondaryRefs.size >= AUTOLINK_MAX_SECONDARY) break;
            addSecondary(entry); 
        }
    }

    const primary = [...primaryRefs];
    const secondary = [...secondaryRefs];
    if (primary.length === 0 && secondary.length === 0) return empty;

    fact.relationships = mergeRelationships(fact.relationships, { primary, secondary, tertiary: [] });

    addDebugLog('debug', `Auto-linked fact: [${category}] ${fact.key} (+${primary.length} primary, +${secondary.length} secondary)`, {
        subsystem: 'db', event: 'fact.autolink', runId,
        data: { key: fact.key, category, primary: primary.length, secondary: secondary.length, targets: [...primary, ...secondary] },
    });
    return { primary, secondary };
}

// Agent-declared semantic links (the link_facts tool). Stored two ways so no
// downstream reader changes: the partner's key ref goes into
// relationships.primary on BOTH facts (the exact shape autoLinkFact writes, so
// relationship-ref expansion and graph extras walk the link for free), and
// fact.agentLinks records { ref, category, reason } so the DB panel can show
// WHY the agent linked them. agentLinks is optional — facts from older
// profiles simply lack the field and keep working unchanged.
export const AGENT_LINK_MAX = 5;

function agentLinkList(fact) {
    if (!Array.isArray(fact.agentLinks)) fact.agentLinks = [];
    return fact.agentLinks;
}

// Bidirectional, atomic: caps are checked BEFORE either side mutates, so a
// rejected link never half-applies. Returns 'linked' | 'duplicate' | 'capped'
// | 'invalid' (same fact on both sides) | 'ambiguous' (two DIFFERENT facts
// whose bare-key refs collide — the categoryless ref scheme cannot represent
// that link, and the caller must report the real cause, not "self-link").
export function linkFactsExplicit(fromFact, fromCategory, toFact, toCategory, reason, runId) {
    const fromRef = autoLinkRef(fromFact);
    const toRef = autoLinkRef(toFact);
    if (!fromRef || !toRef || fromFact === toFact) return 'invalid';
    if (fromRef === toRef) return 'ambiguous';
    const fromLinks = agentLinkList(fromFact);
    const toLinks = agentLinkList(toFact);
    // Duplicate detection must match ref AND category: same-key facts in
    // different categories are distinct link partners, and conflating them
    // produced one-sided mutations that broke the atomicity guarantee above.
    // A legacy entry without a category is treated as a match (lenient).
    const sameLink = (l, ref, cat) => l && String(l.ref || '') === ref
        && (l.category == null || String(l.category) === String(cat));
    const dupFrom = fromLinks.some(l => sameLink(l, toRef, toCategory));
    const dupTo = toLinks.some(l => sameLink(l, fromRef, fromCategory));
    if (dupFrom && dupTo) return 'duplicate';
    if (!dupFrom && fromLinks.length >= AGENT_LINK_MAX) return 'capped';
    if (!dupTo && toLinks.length >= AGENT_LINK_MAX) return 'capped';
    const why = String(reason || '').trim();
    // Stamp mutated facts like upsertFact does — the rehydrate clobber-guard
    // and tombstone adoption judge category freshness by these fields, and an
    // unstamped link-only change would look older than it is and get discarded.
    const linkNow = Date.now();
    if (!dupFrom) {
        fromFact.relationships = mergeRelationships(fromFact.relationships, { primary: [toRef], secondary: [], tertiary: [] });
        fromLinks.push({ ref: toRef, category: toCategory, reason: why });
        fromFact.lastUpdated = linkNow;
    }
    if (!dupTo) {
        toFact.relationships = mergeRelationships(toFact.relationships, { primary: [fromRef], secondary: [], tertiary: [] });
        toLinks.push({ ref: fromRef, category: fromCategory, reason: why });
        toFact.lastUpdated = linkNow;
    }
    addDebugLog('info', `Agent-linked facts: [${fromCategory}] ${fromFact.key} <-> [${toCategory}] ${toFact.key}${why ? ` (${why})` : ''}`, {
        subsystem: 'db', event: 'fact.agentlink', runId,
        data: { from: `${fromCategory}:${fromFact.key}`, to: `${toCategory}:${toFact.key}`, reason: why },
    });
    return 'linked';
}

export function removeFact(db, key) {
    db.facts = db.facts.filter(f => f.key !== key);
    db.updatedAt = Date.now();
    return db;
}

// Exported because the fuzzy fallback in fact-retrieval.js has to apply the SAME
// exclusion searchFactsIndexed applies below: in a two-hander's store every fact
// mentions the character or the user, so those words match nearly everything and
// rank nothing. A layer that dropped them from indexed search but kept them for
// trigram search ranked the whole store by the one word that cannot discriminate.
export function getCharacterNameWords() {
    const names = new Set();
    try {
        const context = getContext();
        const charName = context.characters?.[context.characterId]?.name || '';
        const userName = context.name1 || '';
        for (const name of [charName, userName]) {
            for (const word of name.split(/\s+/)) {
                if (word.length > 2) names.add(word.toLowerCase());
            }

            for (const tok of wordTokens(name, { min: 2 })) names.add(tok);
        }
    } catch (e) {  }
    return names;
}

export function summarizeKeys(databases) {
    if (!databases || Object.keys(databases).length === 0) return '';
    const lines = [];
    for (const [category, db] of Object.entries(databases)) {
        for (const fact of (db.facts || [])) {

            if (!isActiveFact(fact)) continue;
            if (fact.key) lines.push(`${category}/${fact.key}`);
        }
    }
    return lines.join('\n');
}

export const MENU_CATEGORY_ORDER = L1_CATEGORIES;

export function groupedTaxonomyMenu() {
    const overlay = getTaxonomyOverlay();
    const lines = [];
    for (const cat of effectiveCategories()) {
        const node = TAXONOMY[cat];

        if (node) {
            for (const [subArea, leaves] of Object.entries(node)) {
                lines.push(`${cat} ▸ ${subArea}: ${leaves.join(', ')}`);
            }
        }

        const extra = Array.isArray(overlay.aspects[cat]) ? overlay.aspects[cat] : [];
        if (!extra.length) continue;
        const declared = (overlay.subAreas[cat] && typeof overlay.subAreas[cat] === 'object') ? overlay.subAreas[cat] : {};

        const leafSub = new Map();
        for (const [subArea, leaves] of Object.entries(declared)) {
            for (const l of (Array.isArray(leaves) ? leaves : [])) {
                const leaf = String(l || '').trim().toLowerCase();
                if (leaf && !leafSub.has(leaf)) leafSub.set(leaf, String(subArea));
            }
        }

        const builtinLeaves = node ? new Set(Object.values(node).flat()) : new Set();
        const groups = new Map(); 
        for (const raw of extra) {
            const leaf = String(raw || '').trim().toLowerCase();
            if (!leaf || builtinLeaves.has(leaf)) continue;
            const sub = leafSub.get(leaf) || 'Custom';
            if (!groups.has(sub)) groups.set(sub, []);
            const arr = groups.get(sub);
            if (!arr.includes(leaf)) arr.push(leaf);
        }
        for (const [subArea, leaves] of groups) {
            if (leaves.length) lines.push(`${cat} ▸ ${subArea}: ${leaves.join(', ')}`);
        }
    }
    return lines.join('\n');
}

export function dedupeDatabase(db) {
    if (!db || !Array.isArray(db.facts)) return { db, before: 0, after: 0, merged: 0 };
    const before = db.facts.length;

    const preserved = [];
    const reconcilable = [];
    for (const f of db.facts) {
        if (!f || typeof f !== 'object') continue;
        if (isSequenceFact(f) || f.active === false) preserved.push(f);
        else reconcilable.push(f);
    }
    const rebuilt = createEmptyDatabase(db.category);
    rebuilt.facts = [...preserved]; 
    for (const f of reconcilable) {

        upsertFact(rebuilt, { ...f });
    }
    const after = rebuilt.facts.length;
    return {
        db: { ...db, facts: rebuilt.facts, updatedAt: Date.now() },
        before,
        after,
        merged: Math.max(0, before - after),
    };
}

async function fetchAttachmentContent(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) return null;
        return await response.text();
    } catch {
        return null;
    }
}

async function deleteAttachmentFile(url) {
    try {
        // The attachment list in extensionSettings can lag behind the server
        // (settings saves are debounced; a reload/crash between "file deleted"
        // and "settings persisted" leaves a stale entry pointing at a file that
        // is already gone). ST's deleteFileFromServer raises its own
        // "Could not delete file: File not found" toast on that 404, which our
        // catch below cannot suppress — so probe first and treat an already-
        // missing file as success (the goal was for it to be gone; it is).
        try {
            const probe = await fetch(url, { method: 'HEAD' });
            if (probe.status === 404) return;
        } catch {  } // probe unavailable — fall through to the normal delete
        const { deleteFileFromServer } = await import('../../../../chats.js');
        await deleteFileFromServer(url);
    } catch (e) {
        console.error('[BFMemory] Failed to delete file:', e);
    }
}

const DEBUGLOG_PREFIX = 'bf_mem_debuglog_';

function safeChatToken(chatId) {
    return String(chatId || 'default').toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 80) || 'default';
}

function debugLogFileName(chatId) {
    return `${DEBUGLOG_PREFIX}${safeChatToken(chatId)}.json`;
}

export async function loadDebugLogFile(chatId) {
    try {
        const avatar = getCharacterAvatar();
        if (!avatar) return [];
        const context = getContext();
        const attachments = context.extensionSettings?.character_attachments?.[avatar] || [];
        const fileName = debugLogFileName(chatId);
        const attachment = attachments.find(a => a.name === fileName);
        if (!attachment) return []; 
        const content = await fetchAttachmentContent(attachment.url);
        if (!content) return [];
        const parsed = JSON.parse(content);

        const entries = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.entries) ? parsed.entries : []);
        return entries.filter(e => e && typeof e === 'object' && typeof e.message === 'string');
    } catch (e) {
        console.error('[BFMemory] Failed to load debug-log file', e);
        return [];
    }
}

export async function saveDebugLogFile(chatId, entries) {
    try {
        const avatar = getCharacterAvatar();
        if (!avatar) return false; 

        const fileName = debugLogFileName(chatId);
        const payload = {
            v: 1,
            chatId: String(chatId || ''),
            savedAt: Date.now(),
            entries: Array.isArray(entries) ? entries : [],
        };
        const content = JSON.stringify(payload);
        const base64Data = btoa(unescape(encodeURIComponent(content)));

        const context = getContext();
        const extensionSettings = context.extensionSettings;
        if (!extensionSettings.character_attachments) extensionSettings.character_attachments = {};
        if (!extensionSettings.character_attachments[avatar]) extensionSettings.character_attachments[avatar] = [];
        const attachments = extensionSettings.character_attachments[avatar];

        const existingIdx = attachments.findIndex(a => a.name === fileName);
        if (existingIdx >= 0) {
            try { await deleteAttachmentFile(attachments[existingIdx].url); } catch {  }
            attachments.splice(existingIdx, 1);
        }

        const { uploadFileAttachment } = await import('../../../../chats.js');
        const uniqueName = `${Date.now()}_${fileName}`;
        const fileUrl = await uploadFileAttachment(uniqueName, base64Data);
        if (!fileUrl) return false;

        attachments.push({ url: fileUrl, size: content.length, name: fileName, created: Date.now() });

        if (context.saveSettingsDebounced) {
            context.saveSettingsDebounced();
            if (typeof context.saveSettingsDebounced.flush === 'function') context.saveSettingsDebounced.flush();
        }
        return true;
    } catch (e) {
        console.error('[BFMemory] Failed to save debug-log file', e);
        return false;
    }
}

export async function deleteDebugLogFile(chatId) {
    try {
        const avatar = getCharacterAvatar();
        if (!avatar) return;
        const context = getContext();
        const attachments = context.extensionSettings?.character_attachments?.[avatar] || [];
        const fileName = debugLogFileName(chatId);
        const idx = attachments.findIndex(a => a.name === fileName);
        if (idx >= 0) {
            try { await deleteAttachmentFile(attachments[idx].url); } catch {  }
            attachments.splice(idx, 1);

            context.saveSettingsDebounced?.();
            if (typeof context.saveSettingsDebounced?.flush === 'function') context.saveSettingsDebounced.flush();
        }
    } catch (e) {
        console.error('[BFMemory] Failed to delete debug-log file', e);
    }
}

export function getTrackSteps(databases, track) {
    const steps = [];
    for (const [category, db] of Object.entries(databases || {})) {
        for (const fact of (db.facts || [])) {
            if (isSequenceFact(fact) && fact.track === track) {
                steps.push({ fact, category });
            }
        }
    }
    steps.sort((a, b) => (Number(a.fact.ord) || 0) - (Number(b.fact.ord) || 0));
    return steps;
}

const RELATIONSHIP_THREAD_MAX = 16;

function normalizeRelationshipName(name) {
    const n = String(name || '').trim().toLowerCase().replace(/^@/, '').trim();
    if (!n) return '';
    return resolveGenericSubjectToken(n);
}

function relationshipNamesOfFact(fact) {
    const names = new Set();
    const subj = String(deriveSubject(fact) || '').trim();
    if (subj) names.add(subj); 
    const involved = Array.isArray(fact && fact.involved) ? fact.involved : [];
    for (const raw of involved) {
        const t = normalizeRelationshipName(raw);
        if (t) names.add(t);
    }
    return names;
}

export function getRelationshipMomentThread(databases, nameA, nameB, opts = {}) {
    const a = normalizeRelationshipName(nameA);
    const b = normalizeRelationshipName(nameB);
    if (!a && !b) return [];

    const single = !b || a === b;
    const who = a || b; 
    if (single && !who) return [];

    const cap = Math.min(
        RELATIONSHIP_THREAD_MAX,
        Math.max(1, Math.floor(Number(opts && opts.limit)) || RELATIONSHIP_THREAD_MAX),
    );

    const matches = [];
    for (const [category, db] of Object.entries(databases || {})) {
        for (const fact of (db.facts || [])) {
            if (!fact || typeof fact !== 'object') continue;
            const names = relationshipNamesOfFact(fact);
            const kind = normalizeKind(fact.kind);
            let hit = false;
            if (single) {

                hit = names.has(who) && kind === 'moment';
            } else {

                hit = names.has(a) && names.has(b);
            }
            if (hit) matches.push({ fact, category, kind });
        }
    }

    const chrono = (x, y) => {
        const xv = Number.isInteger(x.fact.validAt) ? x.fact.validAt : Number.MAX_SAFE_INTEGER;
        const yv = Number.isInteger(y.fact.validAt) ? y.fact.validAt : Number.MAX_SAFE_INTEGER;
        if (xv !== yv) return xv - yv;
        const xu = Number(x.fact.lastUpdated) || 0;
        const yu = Number(y.fact.lastUpdated) || 0;
        if (xu !== yu) return xu - yu;
        return String(x.fact.key).localeCompare(String(y.fact.key));
    };

    if (matches.length <= cap) {
        matches.sort(chrono);
        return matches.map(m => ({ fact: m.fact, category: m.category }));
    }

    const now = Date.now();
    const kept = matches
        .slice()
        .sort((x, y) => {
            const xm = x.kind === 'moment' ? 1 : 0;
            const ym = y.kind === 'moment' ? 1 : 0;
            if (xm !== ym) return ym - xm; 
            const xsal = salienceScore(x.fact, now);
            const ysal = salienceScore(y.fact, now);
            if (xsal !== ysal) return ysal - xsal; 
            return -chrono(x, y); 
        })
        .slice(0, cap);
    kept.sort(chrono);
    return kept.map(m => ({ fact: m.fact, category: m.category }));
}
