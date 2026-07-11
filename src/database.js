// BF Memory Pipeline - Database Module
// Manages fact databases via SillyTavern Data Bank (character attachments)
// Each database is a JSON file stored as a character attachment

import { addDebugLog } from './settings.js';
import { wordTokens } from './tokenize.js';
import * as host from './host.js';

const DB_PREFIX = 'bf_memory_db_';
// INFINITE FACTS — NEVER DELETE. We no longer evict/delete facts when a category grows.
// The store is durable (IndexedDB working copy + attachment snapshot) and UNBOUNDED per
// category, so correctness ("never lose a fact") is guaranteed. What was the old eviction
// cap is now a SOFT HOT-SET SIZE: when a category holds more than this many ACTIVE
// non-sequence facts, the LOWEST-salience overflow is COLD-TIERED (cold:true) instead of
// deleted. Cold facts stay on disk + in the snapshot, are deprioritized by retrieval/menu,
// and are UN-COLDED the instant they're re-mentioned/updated or directly matched by a query
// (relevance resurrects them). Sequence/track facts and high-importance facts are never
// cold-tiered. Raising HOT_SET_SIZE only widens the always-hot working set (a token-cost
// tradeoff); it never affects whether a fact is kept (everything is kept).
const HOT_SET_SIZE = 50;
// Importance at/above which a fact is PROTECTED from cold-tiering regardless of recency —
// foundational identity facts (importance 5) stay hot even in a huge store.
const COLD_TIER_PROTECT_IMPORTANCE = 5;

// Salience defaults (importance/kind feature). Applied when a fact lacks the field so
// older facts behave sensibly. importance is 1-5 (3 = neutral), kind is trait/state/event/moment.
export const DEFAULT_IMPORTANCE = 3;
export const DEFAULT_KIND = 'trait';
// `moment` = an EPISODIC scene beat (a first, a turning point, a charged exchange) remembered
// WITH its emotional tone in the note — emotionally sticky, append-only like `event` (NEVER
// supersedes). Distinct from `event` so it can decay slower (see HALF_LIFE_DAYS).
const VALID_KINDS = new Set(['trait', 'state', 'event', 'moment']);

// Salience-aware COLD-TIERING tuning (saveDatabase). A fact's keep-score blends normalized
// importance with a recency term, and `kind` sets how fast recency decays:
//   score = IMPORTANCE_WEIGHT*(importance/5) + RECENCY_WEIGHT*recencyDecay(age, kind)
// Traits decay slowly (long half-life → near-permanent hot protection for foundational
// identity facts even when stale); states/events decay fast so transient goals/moods are
// the first to be COLD-TIERED (NOT deleted) when the hot-set overflows. Lowest score is
// cold-tiered first; the fact is never removed.
const IMPORTANCE_WEIGHT = 0.65;
const RECENCY_WEIGHT = 0.35;
// Half-lives in days (recency term = 0.5 ** (ageDays / halfLife)). `moment` is episodic and
// emotionally sticky — it decays MUCH slower than a transient state (3) or a plain event (7)
// but still well short of a foundational trait (90). 30 days: roughly a month of recency
// protection so a significant scene beat (a first, a turning point) stays recallable long after
// the moment passed, without becoming near-permanent the way identity traits are.
const HALF_LIFE_DAYS = { trait: 90, state: 3, event: 7, moment: 30 };

// USE-IT-OR-LOSE-IT (use-driven salience). A fact that actually gets injected into the
// Writer's context is "used" — we bump useCount + lastUsedAt (see markFactsUsed). Usage feeds
// BOTH keep-score (salienceScore) and slot-rank (retrievalSalience) two ways:
//   1. RECENCY REFRESH: effective age is measured from max(lastUpdated, lastUsedAt), so using a
//      fact refreshes it exactly like an update would (it resists kind-decay → stays hot).
//   2. FREQUENCY BONUS: a small log-scaled, CAPPED additive term from useCount. Log-scaling
//      means the first few uses help most and the bonus saturates, so a frequently-used minor
//      fact nudges up the ranking without ever overpowering a foundational importance-5 fact:
//      a full importance term is IMPORTANCE_WEIGHT*(5/5)=0.65, while the use bonus is capped at
//      USE_BONUS_CAP (0.20) — roughly the value of one importance point — so importance stays
//      the dominant signal. Bounded by design; never grows unbounded with use.
// Net effect: "use it" (recently/frequently injected) keeps a fact hot and wins scarce slots;
// "lose it" (never injected) decays on recency alone and drifts cold — but is NEVER deleted.
const USE_BONUS_WEIGHT = 0.06;
const USE_BONUS_CAP = 0.20;

// COLD penalty (salienceScore). A cold-tiered fact is deprioritized overflow: it must sort
// BELOW every hot ACTIVE fact when bounding a candidate set (scopedScribeCandidates)
// so a cold fact only occupies a capped slot when no hot fact contends
// for it — while still ranking cold facts against EACH OTHER by their own salience, and still
// sorting ABOVE fully-superseded (active===false) history, which carries the ~ -1 floor.
// Hot-active scores live in [~0.13, ~1.05]. We compress a cold fact's raw blend into the band
// (-1, 0) by scaling it down and offsetting below zero: COLD_BASE puts the ceiling just under
// the hot floor, COLD_SPAN keeps the whole cold set above the superseded floor.
const COLD_BASE = -0.10;  // cold ceiling: just below the minimum hot-active score (~0.13)
const COLD_SPAN = 0.80;   // cold facts occupy (COLD_BASE - COLD_SPAN, COLD_BASE) ⊂ (-0.9, -0.1)

/**
 * Bounded, log-scaled frequency bonus from a fact's useCount, shared by both salience
 * functions so keep-score and slot-rank strengthen identically. Returns 0 for unused facts.
 * @param {*} useCount
 * @returns {number} additive bonus in [0, USE_BONUS_CAP]
 */
export function useBonus(useCount) {
    const n = Number(useCount);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(USE_BONUS_CAP, USE_BONUS_WEIGHT * Math.log1p(n));
}

/**
 * Effective recency timestamp for salience: the MORE RECENT of lastUpdated and lastUsedAt.
 * Using a fact refreshes it the same way an update does, so a frequently-injected fact resists
 * kind-decay even if its stored value hasn't changed. Returns 0 when neither is set.
 * @param {{lastUpdated?: number, lastUsedAt?: number}} fact
 * @returns {number} ms epoch (0 = never updated/used → treated as very old)
 */
export function effectiveRecencyTs(fact) {
    const upd = Number(fact?.lastUpdated) || 0;
    const used = Number(fact?.lastUsedAt) || 0;
    return Math.max(upd, used);
}

/**
 * Clamp an importance value to an integer 1-5, defaulting when absent/invalid.
 * @param {*} v
 * @returns {number} 1..5
 */
export function clampImportance(v) {
    // Treat null/undefined/'' as "absent" → default. (Bugfix: Number(null) and Number('') are 0,
    // which is finite, so they used to slip past the guard and clamp to importance 1 — silently
    // downgrading every value-less fact and skewing salience / cold-tiering / retrieval ranking.)
    const n = (v === null || v === undefined || v === '') ? NaN : Math.round(Number(v));
    if (!Number.isFinite(n)) return DEFAULT_IMPORTANCE;
    return Math.min(5, Math.max(1, n));
}

/**
 * Normalize a kind to one of trait|state|event|moment, defaulting when absent/invalid.
 * @param {*} v
 * @returns {('trait'|'state'|'event'|'moment')}
 */
export function normalizeKind(v) {
    const k = String(v || '').trim().toLowerCase();
    return VALID_KINDS.has(k) ? k : DEFAULT_KIND;
}

// Max length of a `tone` descriptor (episodic-memory feature). A tone is a SHORT emotional
// label ("tender", "tense", "bittersweet") — clamp hard so it can't grow into prose (that
// belongs in the note/`context`).
const TONE_MAX_LEN = 40;

/**
 * Normalize an optional `tone` (episodic-memory feature): a short emotional descriptor for a
 * `moment`-kind fact. Collapses whitespace and hard-clamps to TONE_MAX_LEN chars. Returns ''
 * for absent/blank input so callers can omit the field (lean / back-compat).
 * @param {*} v
 * @returns {string} clamped tone, or '' when absent/blank
 */
export function normalizeTone(v) {
    const t = String(v ?? '').replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, TONE_MAX_LEN) : '';
}

// =============================================================================
// 3-LAYER FACT-ORGANIZATION MODEL (taxonomy). Replaces the old single `category`
// axis + character-as-`subject` branch. The character is now a deep TAG, never a
// menu branch, so characters don't each become a top-level branch (which dragged
// ALL of a character's facts into the detail finder — a token cost).
//
//   LAYER 1 = `category`  — rough, genre-agnostic DOMAIN. Canonical set below.
//   LAYER 2 = `aspect`    — a granular, CHARACTER-AGNOSTIC sub-bucket WITHIN the
//                           category, picked from a small FIXED vocab per category.
//   LAYER 3 = CHARACTER TAG(s) — the who-it's-about, carried in `involved`/`subject`
//                           as `@<name>`/`@npc`, NOT as the menu axis.
//
// The full Layer-1 + Layer-2 skeleton is a CODE CONSTANT (TAXONOMY) so it can be
// SEEDED into the menu / Database tab from turn 1 even with zero facts.
// =============================================================================

// LAYER 1 — canonical category set (menu order; Unsorted always last as the catch-all).
export const L1_CATEGORIES = ['People', 'Places', 'Things', 'Relationships', 'Events', 'World', 'Unsorted'];

// LAYER 2 — fixed aspect vocab PER category, now a 3-LEVEL NESTED TREE (granular, generic,
// character-agnostic). Each Layer-1 category maps to an OBJECT keyed by SUB-AREA (the new
// middle navigation tier, a.k.a. "facet group") whose value is an array of LEAF aspects.
//
//   Category (L1, 7 fixed)  ▸  Sub-area (L1.5, ~70 total, NAVIGATION-ONLY)  ▸  leaf (L2, ~1000)
//
// The SUB-AREA is a grouping/drill device ONLY: it is NOT stored on a fact and is NOT a new
// menu axis — facts still carry just `category` + `aspect` (a leaf string). The LEAF is what
// gets written to `fact.aspect`, exactly as before; `flatVocab(cat)` (Object.values().flat())
// reproduces the old FLAT per-category array so every existing consumer (aspectVocabFor,
// normalizeAspect, summarizeMenu, deriveAspect, the Database tab) is UNCHANGED — they still see
// a flat per-category vocab, just a much larger one.
//
// Each leaf is a SCENE-TRIGGER drawer: narrow enough that it's plainly irrelevant most turns, so
// when the planner "opens" one it's a real signal. The note-taker (Agent 3) DRILLS the tree
// (category ▸ sub-area ▸ leaf) and PICKS the MOST SPECIFIC leaf; an out-of-vocab value snaps to
// the category default (see normalizeAspect). The FIRST leaf of each category's FIRST sub-area is
// the safest coarse fallback, kept explicit per category in DEFAULT_ASPECT. Relationships stay
// ABSTRACT/topical (NOT character-keyed) — the who↔who is carried by the `subj:`/`with:@<name>`
// pair-tag (Layer 3), never a leaf.
//
// BACK-COMPAT: this set is a strict SUPERSET of the pre-expansion ~90 flat leaves — every old
// leaf survives as a leaf here (so stored facts keep resolving), and renamed/synonym concepts
// route via the synonym map (LEGACY_ASPECT_MAP, below). Leaf names are snake_case, one canonical
// name per concept (synonyms live in the map, never as parallel leaves). ~1000 leaves / ~70
// sub-areas total; People deliberately holds ~⅓ (RP memory is mostly about people). The former
// `Time` category folds in as World sub-areas (Calendar/Clock/Schedule/Cycles/Reckoning) so the
// 7 fixed L1 categories are unchanged.
export const TAXONOMY = {
    People: {
        // ── current state / who they are ──────────────────────────────────────────────
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
        // ── body & look ───────────────────────────────────────────────────────────────
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
        // ── inner life ──────────────────────────────────────────────────────────────
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
        // ── how they act ──────────────────────────────────────────────────────────────
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
        // ── capabilities ──────────────────────────────────────────────────────────────
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
        // ── standing & means ────────────────────────────────────────────────────────
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
        // ── daily life ────────────────────────────────────────────────────────────────
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
        // ABSTRACT/topical leaves ONLY — who↔who is the subj:/with: pair-tag, never a leaf.
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
        // ── Time folds in here (former Time category) ─────────────────────────────────
        'Calendar': ['time', 'date', 'year', 'season', 'month', 'day_of_week', 'era', 'age_of_world', 'historical_timeline'],
        'Clock': ['time_of_day', 'hour', 'duration', 'elapsed_time', 'moment'],
        'Schedule': ['deadline', 'recurring_event', 'anniversary', 'curfew', 'shift', 'appointment_time'],
        'Cycles': ['cycle', 'phase', 'festival_date', 'market_day', 'lunar_phase', 'seasonal_cycle'],
        'Reckoning': ['timekeeping_system', 'calendar_system', 'time_since', 'countdown', 'epoch'],
    },
    Unsorted: {
        // The always-read escape hatch + a thin triage staging lane (still resolves like any leaf).
        'Triage': ['misc', 'ambiguous', 'pending_promotion', 'meta_note', 'correction', 'ooc'],
    },
};

// Per-category fallback aspect (used when Agent 3 omits/invalid `aspect:`, OR when a pre-redesign
// fact's legacy aspect maps to nothing — see LEGACY_ASPECT_MAP). Chosen as the safest COARSE home
// per category (the first vocab entry by convention). `status` for People (current-state). Kept
// explicit so the choice is auditable.
const DEFAULT_ASPECT = {
    People: 'status',
    Places: 'feature',
    Things: 'object',
    Relationships: 'history',
    Events: 'scene',
    World: 'lore',
    Unsorted: 'misc',
};

// SYNONYM / BACK-COMPAT aspect map (raw aspect -> CANONICAL leaf). This is the synonym layer:
// it routes (a) PRE-REDESIGN Layer-2 vocab that was renamed (`body`->`appearance`, `goals`->
// `current_goal`, ...) and (b) common SYNONYMS the Scribe/legacy facts may emit for a canonical
// leaf (`phobias`->`fears`, `tattoo`->`tattoos`, `occupation`->`career`, `lover`->`romance`, ...)
// onto the single canonical leaf for that concept. One canonical leaf per concept — synonyms live
// HERE, never as parallel leaves in TAXONOMY.
//
// On READ, normalizeAspect: exact-leaf hit returns as-is; ELSE a synonym/legacy entry whose mapped
// target is a VALID leaf for THIS category resolves to the canonical leaf (logged as
// `fact.remapped` / LEGACY_ASPECT_REMAP); else the category default. The per-category validity
// guard means an entry only fires where the canonical target actually exists (no cross-category
// leakage), so a synonym can be listed once and safely ignored in categories that lack the target.
// This keeps existing facts retrievable under the new menu without a migration write. Keys are
// lowercased. Entries whose key is ALSO a valid leaf are inert (the exact-leaf hit wins first) but
// kept for documentation/intent.
const LEGACY_ASPECT_MAP = {
    // ── People: pre-redesign renamed aspects ──────────────────────────────────────────
    identity:   'identity',
    appearance: 'appearance',
    body:       'appearance',   // old `body` (physiology+marks) -> appearance (marks/look)
    background: 'childhood',    // old `background` (origin/past) -> childhood (formative past)
    role:       'career',       // old `role` (job/function) -> career
    // `status` (People current-state) stays `status` (still a leaf) — exact-leaf hit, no remap.
    mood:       'mood',
    goals:      'current_goal', // old `goals` -> current_goal
    goal:       'current_goal',
    behavior:   'habits',       // old `behavior` (tells/mannerisms) -> habits
    skills:     'skills',
    // ── People: common synonyms -> canonical leaf ─────────────────────────────────────
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
    residence_place: 'home',     // a person's home (vs Places residence)
    location:   'current_location', // a PERSON's location -> current_location (Places has own `location`)
    routine:    'daily_routine',
    pet:        'pets',
    hobby:      'hobbies',
    self_concept_self: 'self_concept',
    // ── Places (old: residence/public/region/feature) ─────────────────────────────────
    residence:  'function',     // a dwelling -> what the place is for
    public:     'function',
    region:     'geography',    // inert when `region` is itself a leaf (exact hit wins); kept for old facts
    decor_place:'decor',
    // ── Things (old: object/key-item/substance) — `key-item` had a hyphen ──────────────
    'key-item': 'key_item',
    keyitem:    'key_item',
    item:       'object',
    gear:       'tool',
    armor:      'armor_item',
    food_item:  'food',
    value_of_item: 'worth',
    // ── Relationships (old: bond/tension/history) ─────────────────────────────────────
    bond:       'friendship',   // old generic `bond` -> friendship (closest abstract tie)
    lover:      'romance',
    love:       'romance',
    relationship_status: 'status_of_relationship',
    // ── Events / World — most old labels are still leaves (exact-leaf hit, no remap) ───
    // World old `time` stays a leaf (folded into the Calendar sub-area). No entry needed.
    historical_event: 'history',
    // ── Unsorted -> misc (still a leaf). ──────────────────────────────────────────────
    ambiguous_misc: 'misc',
};

/**
 * BACK-COMPAT category map (old 7-bucket set -> new Layer-1 set). Existing DBs shipped
 * with categories Identity/Relationships/World/Status/Behavior/History/Unsorted; this maps
 * them onto the new People/Places/Things/Relationships/Events/World/Unsorted set on READ so
 * old facts re-bucket instead of breaking. Status of a PERSON -> People, but a Status fact
 * whose scope is `place` files under Places; World stays World unless its scope is place/event
 * (then Places/Events). Case-insensitive. Unknown categories (already-new or custom) pass
 * through unchanged (capitalization-normalized to the canonical spelling when it matches a
 * Layer-1 name).
 * @param {string} category - the stored category name
 * @param {FactSchema} [fact] - optional fact for scope-sensitive remap (Status/World)
 * @returns {string} a canonical Layer-1 category name
 */
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
            // Already a new Layer-1 name (any case) — normalize to canonical spelling.
            for (const canon of L1_CATEGORIES) {
                if (canon.toLowerCase() === c) return canon;
            }
            // A USER-ADDED overlay category (any case) — normalize to its canonical spelling so
            // facts file there and the Database tab/menu recognize it as a real bucket.
            for (const canon of overlayCategories()) {
                if (canon.toLowerCase() === c) return canon;
            }
            // Genuinely unknown/custom — keep verbatim so we never silently drop a real bucket.
            return category;
    }
}

// =============================================================================
// USER TAXONOMY OVERLAY (persisted, GLOBAL across chats)
// =============================================================================
// The built-in TAXONOMY (above) is a CODE CONSTANT. On top of it we merge an optional USER
// OVERLAY persisted in the extension settings object (settings.js DEFAULT_SETTINGS.taxonomyOverlay)
// so a user can ADD their own Layer-1 categories and Layer-2 leaves from the Database tab without
// touching code. The overlay is DATA-ONLY and ADDITIVE — it can never remove or shadow a built-in
// (the 7 fixed L1 + ~939 leaves always survive); it only widens the effective vocab. Shape:
//   { categories: string[],                         // extra L1 names
//     aspects:    { [category]: string[] },         // extra leaves per category
//     subAreas:   { [category]: { [subArea]: string[] } } } // OPTIONAL grouping for the menu
// Read via host.getExtensionSettings() (database.js already imports host) so there is NO static
// settings.js -> database.js import cycle. The AI-expansion flow (a LATER task) writes to the SAME
// overlay shape.
//
// PERFORMANCE: flatVocab is called per-fact in hot paths (buildMemoryIndex), so we DO NOT re-read
// settings + rebuild the merged array on every call. Instead we MEMOIZE the merged per-category
// leaf vocab in `_overlayVocabMemo` and the canonical category set in `_overlayCatsMemo`; the
// settings UI calls invalidateTaxonomyOverlayCache() after any add to drop the memo. Reading the
// overlay once to (re)build the memo is the only settings read on the hot path.

/** @type {Map<string, string[]>|null} memoized merged (built-in + overlay) flat vocab per canon category. */
let _overlayVocabMemo = null;
/** @type {string[]|null} memoized list of overlay-added L1 category names (canon-cased). */
let _overlayCatsMemo = null;

/**
 * Drop the memoized merged taxonomy so the next flatVocab/category read rebuilds it from the
 * current overlay. Call this AFTER any persisted overlay change (settings UI add). Cheap.
 * @returns {void}
 */
export function invalidateTaxonomyOverlayCache() {
    _overlayVocabMemo = null;
    _overlayCatsMemo = null;
}

/**
 * Read the raw persisted overlay object from extension settings, null-safe. Always returns a
 * well-formed shape (empty arrays/objects) so callers never branch on absence. Pure read.
 * @returns {{categories: string[], aspects: Object<string,string[]>, subAreas: Object<string,Object<string,string[]>>}}
 */
export function getTaxonomyOverlay() {
    const ov = host.getExtensionSettings()?.taxonomyOverlay;
    return {
        categories: Array.isArray(ov?.categories) ? ov.categories : [],
        aspects: (ov?.aspects && typeof ov.aspects === 'object' && !Array.isArray(ov.aspects)) ? ov.aspects : {},
        subAreas: (ov?.subAreas && typeof ov.subAreas === 'object' && !Array.isArray(ov.subAreas)) ? ov.subAreas : {},
    };
}

/**
 * The list of user-added Layer-1 category names (memoized), normalized so a built-in name in
 * any case is NOT re-added (built-ins always win). Used by mapLegacyCategory (so an overlay
 * category resolves to itself as canonical) and the skeleton/menu builders.
 * @returns {string[]} extra canonical category names not already in L1_CATEGORIES
 */
function overlayCategories() {
    if (_overlayCatsMemo) return _overlayCatsMemo;
    const builtinLower = new Set(L1_CATEGORIES.map(c => c.toLowerCase()));
    const seen = new Set();
    const out = [];
    for (const raw of getTaxonomyOverlay().categories) {
        const name = String(raw || '').trim();
        if (!name) continue;
        const lc = name.toLowerCase();
        if (builtinLower.has(lc) || seen.has(lc)) continue; // never shadow a built-in / dedup
        seen.add(lc);
        out.push(name);
    }
    _overlayCatsMemo = out;
    return out;
}

/**
 * The full effective set of canonical Layer-1 categories: the 7 built-ins followed by any
 * user-added overlay categories (Unsorted stays the built-in catch-all; overlay cats append
 * after it, like custom buckets always have). Used to widen the skeleton + menus.
 * @returns {string[]}
 */
export function effectiveCategories() {
    return [...L1_CATEGORIES, ...overlayCategories()];
}

/**
 * FLATTENER — the bridge from the nested 3-level TAXONOMY (`{ subArea: [leaf, ...] }`) back to
 * the FLAT per-category leaf array the rest of the system has always consumed. Every consumer
 * that needs "the list of leaves for this category" (aspectVocabFor, normalizeAspect, the menus,
 * the Database tab) routes through here, so the nested shape is purely organizational and the
 * FLAT-per-category contract is preserved with ZERO behavior change. Returns Unsorted's leaves
 * for an unknown category so a custom bucket still has a default.
 *
 * USER OVERLAY: the built-in leaves are followed by any overlay `aspects[category]` leaves
 * (deduped, built-ins win), memoized per canon category so this stays cheap on the hot path.
 * An install with an EMPTY overlay returns byte-identically to the built-in-only array.
 * @param {string} category - a Layer-1 category name (legacy names accepted; canon-mapped here)
 * @returns {string[]} the flat array of leaf aspects under that category, in tree order
 */
export function flatVocab(category) {
    const canon = mapLegacyCategory(category);
    if (!_overlayVocabMemo) _overlayVocabMemo = new Map();
    const cached = _overlayVocabMemo.get(canon);
    if (cached) return cached;

    const node = TAXONOMY[canon] || TAXONOMY.Unsorted;
    const builtin = Object.values(node).flat();
    // Overlay leaves for this canon category (or an overlay-only custom category, which has no
    // built-in node so `builtin` is Unsorted's list — its overlay leaves still merge in).
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

/**
 * The fixed Layer-2 aspect vocab (FLAT leaf array) for a Layer-1 category (after legacy-mapping
 * the name). Thin alias over flatVocab kept for back-compat with existing callers (settings.js
 * Database tab, summarizeMenu*, etc.) — same flat shape as before the 3-level reshape.
 * @param {string} category
 * @returns {string[]}
 */
export function aspectVocabFor(category) {
    return flatVocab(category);
}

/** The default/fallback aspect for a (legacy-mapped) category (first leaf of flatVocab). */
export function defaultAspectFor(category) {
    const canon = mapLegacyCategory(category);
    return DEFAULT_ASPECT[canon] || flatVocab(canon)[0] || 'misc';
}

/**
 * Normalize an aspect against the fixed vocab for its category (Layer 2). Lowercased,
 * trimmed; falls back to the category's default aspect when absent/invalid so a fact
 * ALWAYS resolves to a real bucket. Back-compat (two layers):
 *   1) A value already in the NEW vocab passes through unchanged.
 *   2) A PRE-REDESIGN aspect not in the new vocab is mapped to its nearest new label via
 *      LEGACY_ASPECT_MAP (so old facts re-bucket instead of all collapsing to the default).
 *   3) Anything still unknown (or absent) → the category default.
 * Facts written before the aspect feature have no `aspect` and resolve to the default here.
 * @param {*} v - raw aspect value
 * @param {string} category
 * @returns {string}
 */
export function normalizeAspect(v, category) {
    const a = String(v || '').trim().toLowerCase();
    const vocab = aspectVocabFor(category);
    if (a && vocab.includes(a)) return a;
    // Back-compat: re-map a pre-redesign aspect to its nearest new label, but only if the
    // mapped target is actually valid for THIS category's vocab (avoids cross-category leakage).
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

/**
 * Resolve a fact's Layer-2 aspect: prefer the explicit `aspect` field (emitted by Agent 3
 * via the `aspect:` marker), normalized against the category's fixed vocab; otherwise the
 * category default. Always returns a valid aspect for the fact's (legacy-mapped) category.
 * @param {FactSchema} fact
 * @returns {string}
 */
export function deriveAspect(fact) {
    if (!fact) return 'misc';
    return normalizeAspect(fact.aspect, fact.category);
}

/**
 * Canonicalize a USER-ENTERED leaf surface form to the snake_case style of the built-in vocab:
 * lowercase, trim, strip a leading article (a/an/the), collapse whitespace + hyphens to a single
 * `_`, and drop any leftover non `[a-z0-9_]` punctuation. Returns '' for empty/garbage input so
 * callers can reject it. Mirrors the leaf-naming convention (snake_case, one word-run per concept).
 * @param {*} v - raw user input
 * @returns {string} a canonical snake_case leaf, or '' when nothing usable remains
 */
export function canonicalizeLeafSurface(v) {
    let s = String(v ?? '').trim().toLowerCase();
    if (!s) return '';
    s = s.replace(/^(?:a|an|the)\s+/, '');          // strip a leading article
    s = s.replace(/[\s\-]+/g, '_');                  // spaces / hyphens -> single underscore
    s = s.replace(/[^a-z0-9_]+/g, '');               // drop other punctuation
    s = s.replace(/_+/g, '_').replace(/^_+|_+$/g, ''); // collapse / trim underscores
    return s;
}

/**
 * DEDUP CHECK for a user-added leaf: given a CANONICAL surface (from canonicalizeLeafSurface) and
 * a category, decide whether it is ALREADY COVERED by the effective vocab (built-in + overlay) or
 * the synonym/legacy map. Returns the canonical leaf it collides with, or '' when the surface is
 * genuinely new and safe to add. One canonical leaf per concept — synonyms route to their target.
 *   - exact hit in the effective per-category vocab            -> that leaf (already a leaf)
 *   - a synonym/legacy alias whose target is valid HERE        -> the target leaf
 * @param {string} canonicalSurface - output of canonicalizeLeafSurface
 * @param {string} category - a Layer-1 category name (legacy/overlay names accepted)
 * @returns {string} the existing canonical leaf it duplicates, or '' if new
 */
export function findExistingLeaf(canonicalSurface, category) {
    const a = String(canonicalSurface || '').trim().toLowerCase();
    if (!a) return '';
    const vocab = flatVocab(category);
    if (vocab.includes(a)) return a; // already a real leaf (built-in or overlay)
    // Known synonym/legacy alias whose canonical target is valid for THIS category's vocab.
    if (Object.prototype.hasOwnProperty.call(LEGACY_ASPECT_MAP, a)) {
        const mapped = LEGACY_ASPECT_MAP[a];
        if (vocab.includes(mapped)) return mapped;
    }
    return '';
}

/**
 * Build the empty Layer-1 skeleton: a `{ category -> empty DatabaseSchema }` map covering
 * every canonical Layer-1 category, with ZERO facts. Used to SEED the menu / Database tab
 * so the full taxonomy is present from turn 1 even before any fact lands. These skeleton
 * DBs are kept IN MEMORY only — they are NOT persisted as empty attachment files (that
 * would spam the backend with 7 empty uploads per chat); a category file is written only
 * when a real fact lands (write-on-first-fact, via saveDatabase from applyUpdates).
 * @returns {Object<string, DatabaseSchema>}
 */
export function buildSkeletonDatabases() {
    const out = {};
    // Built-in L1 first, then any user-added overlay categories (effectiveCategories) so a
    // custom bucket shows in the Database tab / menu even before a fact lands. Empty overlay
    // => identical to the built-in-only skeleton.
    for (const cat of effectiveCategories()) out[cat] = createEmptyDatabase(cat);
    return out;
}

/**
 * Merge the empty Layer-1 skeleton UNDER a real database map (real DBs win): every canonical
 * category is guaranteed present (empty when it has no stored facts) so the menu / Database
 * tab always show the full taxonomy, while any category that already has facts is preserved
 * untouched. Pure / non-persisting. Custom (non-canonical) categories pass through.
 * @param {Object<string, DatabaseSchema>} databases - real (loaded) databases
 * @returns {Object<string, DatabaseSchema>}
 */
export function withSkeleton(databases) {
    const out = buildSkeletonDatabases();
    for (const [cat, db] of Object.entries(databases || {})) out[cat] = db;
    return out;
}

// Scope feature: a fact's recall axis — does it stick to a PERSON (traits/state/behavior),
// a PLACE/world thing (recalled when the location matters even if its owner is absent), or
// an EVENT (something that happened, anchored to place + people + time). Optional; when a
// fact lacks it we INFER deterministically from category/track (see deriveScope).
const VALID_SCOPES = new Set(['character', 'place', 'event']);

// Shared "drawer" subject for unnamed/incidental people (NPC feature). Facts about a one-off
// or unnamed person route here so they don't mint a fresh subject per walk-on; the provisional
// name/descriptor is retained on the fact (involved/about) for a later promotion step.
export const NPC_SUBJECT = 'npc';

/**
 * Normalize a scope to one of character|place|event, or '' when absent/invalid (so callers
 * can fall back to inference). Lowercased, trimmed.
 * @param {*} v
 * @returns {('character'|'place'|'event'|'')}
 */
export function normalizeScope(v) {
    const s = String(v || '').trim().toLowerCase();
    return VALID_SCOPES.has(s) ? s : '';
}

/**
 * Resolve a fact's scope (scope feature). Prefers an explicit `scope` field (emitted by
 * Agent 3 via the `scope:` marker); otherwise INFERS deterministically from category +
 * track/sequence:
 *   - track/sequence step           -> event
 *   - History                       -> event
 *   - World                         -> place
 *   - Status                        -> character (current state of someone) unless its
 *                                      subject clearly names a place (handled by callers via
 *                                      explicit scope/subj; here Status defaults to character)
 *   - Identity/Behavior/Relationships/Unsorted/other -> character
 * Back-compat: facts written before this feature have no `scope` and resolve via inference.
 * @param {FactSchema} fact
 * @returns {('character'|'place'|'event')}
 */
export function deriveScope(fact) {
    const explicit = normalizeScope(fact?.scope);
    if (explicit) return explicit;
    if (isSequenceFact(fact)) return 'event';
    // 3-layer model: switch on the canonical Layer-1 category (mapLegacyCategory also accepts
    // the OLD names, so a fact stored under a legacy category still infers correctly on read).
    switch (mapLegacyCategory(fact?.category).toLowerCase()) {
        case 'events': return 'event';
        case 'places': return 'place';
        case 'world': return 'place';
        default: return 'character'; // People/Things/Relationships/Unsorted -> character
    }
}

/**
 * True when a fact is CURRENTLY valid (supersession feature). A fact is active unless it
 * has been explicitly superseded (`active === false`). Absent `active` => active, so
 * every fact written before this feature is treated as currently valid (back-compat).
 * @param {FactSchema} fact
 * @returns {boolean}
 */
export function isActiveFact(fact) {
    return !(fact && fact.active === false);
}

/**
 * True when a fact is HOT (in the preferred working set) — the default. A fact is cold ONLY
 * when explicitly flagged `cold === true` by the salience-aware cold-tiering in saveDatabase.
 * Absent/false `cold` => hot, so every fact written before this feature is hot (back-compat).
 * Cold facts are NEVER deleted: they stay durable in IDB + the snapshot and remain queryable
 * (relevance can resurrect them); they are only deprioritized by retrieval/menu.
 * @param {FactSchema} fact
 * @returns {boolean}
 */
export function isHotFact(fact) {
    return !(fact && fact.cold === true);
}

/**
 * True when a fact is COLD (deprioritized overflow). Convenience inverse of isHotFact.
 * @param {FactSchema} fact
 * @returns {boolean}
 */
export function isColdFact(fact) {
    return !!(fact && fact.cold === true);
}

/**
 * UN-COLD a fact in place (resurrection). Clears the `cold` flag and logs `fact.resurfaced`
 * (standing debug-logging rule) so the Debug tab shows a cold fact was pulled back into the
 * hot working set because it was re-mentioned/updated or directly matched a query. No-op (and
 * no log) when the fact was already hot. Returns true when it actually un-colded.
 * @param {FactSchema} fact - the stored fact object (mutated in place)
 * @param {string} category - owning category (for the log)
 * @param {string} reason - structured reason code (e.g. 'COLD_REACTIVATED')
 * @param {string} [detail] - optional human note (e.g. what touched it)
 * @returns {boolean}
 */
export function uncoldFact(fact, category, reason = 'COLD_REACTIVATED', detail = '') {
    if (!fact || fact.cold !== true) return false;
    delete fact.cold;
    addDebugLog('info', `Fact resurfaced (un-cold): [${category}] ${fact.key}${detail ? ` — ${detail}` : ''}`, {
        subsystem: 'db', event: 'fact.resurfaced', reason,
        data: { category, key: fact.key, salienceScore: Number(salienceScore(fact, Date.now()).toFixed(3)) },
    });
    return true;
}

/**
 * MARK a single fact COLD in place (never-delete demotion). Sets `cold:true` so the fact is
 * deprioritized by retrieval/menu but stays DURABLE on disk (IDB + snapshot) and fully
 * resurrectable (a re-mention/update/direct match un-colds it via uncoldFact, exactly like any
 * cold-tiered overflow fact). This is the single-fact counterpart to coldTierOverflow's bulk
 * demotion, used when an automated pass (e.g. the reflection #REEVAL "drop" verdict) judges a
 * fact low-value — instead of DELETING it (which would violate the never-delete invariant) we
 * cold-tier it. Logs `fact.demoted` (standing debug-logging rule), mirroring coldTierOverflow's
 * log so a "drop" surfaces in the Debug tab as a COLD-TIERING, not a deletion. No-op (no re-log)
 * when the fact is already cold. Returns true when it actually newly cold-tiered the fact.
 * @param {FactSchema} fact - the stored fact object (mutated in place)
 * @param {string} category - owning category (for the log)
 * @param {string} reason - structured reason code (e.g. 'REEVAL_DROP')
 * @param {string} [detail] - optional human note (e.g. why it was demoted)
 * @returns {boolean}
 */
export function markFactCold(fact, category, reason = 'DEMOTED_LOW_VALUE', detail = '') {
    if (!fact || fact.cold === true) return false;
    fact.cold = true;
    addDebugLog('info', `Fact cold-tiered (kept, deprioritized): [${category}] ${fact.key}${detail ? ` — ${detail}` : ''}`, {
        subsystem: 'db', event: 'fact.demoted', reason,
        data: { category, key: fact.key, salienceScore: Number(salienceScore(fact, Date.now()).toFixed(3)) },
    });
    return true;
}

/**
 * Decide whether an INCOMING write should SUPERSEDE the existing fact it reconciles to
 * (i.e. mark the old value as ended and record the new current value) rather than just
 * correct it in place. Supersession is reserved for CHANGEABLE STATE — a status, a
 * current location/goal that genuinely moved on — so the timeline stays truthful while
 * durable traits (name/age/species) keep today's silent in-place correction (a typo fix
 * is NOT a state change). It triggers only when ALL hold:
 *   - the EXISTING fact is itself a `state` (durable traits are corrected, not superseded),
 *   - the incoming write does not itself declare a non-state kind (so a write explicitly
 *     re-typing the fact as a trait is treated as a correction), and
 *   - the value MATERIALLY changed (a no-op re-mention never supersedes).
 * An explicit Agent-3 signal (`supersedes:true` on the incoming fact) forces supersession
 * on a materially-changed value regardless of kind heuristics. Track/sequence facts are
 * handled separately (append-only) and never reach this path.
 * @param {FactSchema} existing - the fact being reconciled to
 * @param {FactSchema} incoming - the new write
 * @param {boolean} explicitSignal - true when Agent 3 emitted the `~` supersession marker
 * @returns {boolean}
 */
function shouldSupersede(existing, incoming, explicitSignal) {
    if (!existing || !incoming) return false;
    // Never supersede when the value is unchanged — that's a pure re-mention/no-op.
    if (factValuesEqual(existing.value, incoming.value)) return false;
    // Explicit writer signal wins (still requires a materially-changed value, checked above).
    if (explicitSignal === true) return true;
    // Heuristic: only changeable STATE supersedes. Existing must be a state; and if the
    // incoming write explicitly re-types the fact as a NON-state kind, treat it as a
    // correction (in-place) rather than a supersession.
    const existingKind = normalizeKind(existing.kind);
    if (existingKind !== 'state') return false;
    const incHasKind = incoming.kind !== undefined && incoming.kind !== null && String(incoming.kind).trim();
    if (incHasKind && normalizeKind(incoming.kind) !== 'state') return false;
    return true;
}

/** Loose value equality (trim + case-insensitive) — mirrors agent-memory's sameValue. */
function factValuesEqual(a, b) {
    return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}

/**
 * Compute a salience keep-score for a non-sequence fact. Higher = more worth keeping.
 * Blends importance (foundational-ness) with kind-modulated recency decay so durable
 * traits survive even when old, while transient states/events fade fast.
 *
 * `penalizeCold`: when true, an already-cold fact is sunk below every hot ACTIVE fact (see
 * COLD_BASE/COLD_SPAN) so the candidate-bounding caller (scopedScribeCandidates)
 * only admits a cold fact when no hot fact contends for the slot. It
 * defaults to FALSE so the cold-tiering ranker (coldTierOverflow) keeps ranking by INTRINSIC
 * salience — otherwise an already-cold fact could never climb back into the hot set, breaking
 * resurrection (coldTierOverflow keepHot / COLD_REACTIVATED).
 * @param {FactSchema} fact
 * @param {number} now - reference timestamp (ms)
 * @param {boolean} [penalizeCold=false] - apply the cold-fact sink (candidate-bounding only)
 * @returns {number}
 */
function salienceScore(fact, now, penalizeCold = false) {
    // Superseded facts (temporal-validity feature) carry the LOWEST salience so they are
    // evicted FIRST under the cap — history compresses gracefully without crowding out
    // currently-valid facts. A tiny recency tiebreak keeps the most-recently-superseded
    // snapshot last to go among the inactive set.
    if (fact && fact.active === false) {
        const at = Number(fact.supersededAt) || Number(fact.lastUpdated) || 0;
        const ageDays = at > 0 ? Math.max(0, (now - at) / 86400000) : 36500;
        return -1 + Math.pow(0.5, ageDays / 7) * 0.001; // ~ -1, newer-superseded slightly higher
    }
    const importance = clampImportance(fact?.importance);
    const kind = normalizeKind(fact?.kind);
    // USE-IT-OR-LOSE-IT: measure age from the MORE RECENT of lastUpdated/lastUsedAt, so a fact
    // that keeps getting injected refreshes its recency exactly like an update would.
    const last = effectiveRecencyTs(fact);
    const ageDays = last > 0 ? Math.max(0, (now - last) / 86400000) : 36500; // never-updated/used → very old
    const halfLife = HALF_LIFE_DAYS[kind] || HALF_LIFE_DAYS.trait;
    const recency = Math.pow(0.5, ageDays / halfLife); // 1 (fresh) → 0 (ancient)
    // Bounded log-scaled frequency bonus so often-injected facts resist cold-tiering without
    // overpowering a foundational importance-5 fact (cap ≈ one importance point).
    const raw = IMPORTANCE_WEIGHT * (importance / 5) + RECENCY_WEIGHT * recency + useBonus(fact?.useCount);
    // COLD penalty (candidate-bounding only — see penalizeCold doc): a cold-tiered (overflow) fact
    // must sort BELOW every hot ACTIVE fact yet keep its own importance/recency order and stay ABOVE
    // superseded history. We map its raw blend (in [0, ~1.05]) into the (-0.9, -0.1) band so the
    // caller that bounds candidate sets (scopedScribeCandidates) only admits a
    // cold fact when no hot fact contends for the slot — making real the "cold facts sort last"
    // claim those comments assert. (raw / 1.05 normalizes to [0,1] before the band map.)
    if (penalizeCold && fact && fact.cold === true) {
        return COLD_BASE - COLD_SPAN + (raw / 1.05) * COLD_SPAN;
    }
    return raw;
}

// Local context accessor — routes through the host seam (host.js). Preserves the
// original throw-on-missing semantics (callers below deref `context.X` with `?.`,
// and the few that aren't in a try/catch expect an exception when the host is gone).
function getContext() {
    const ctx = host.getCtx();
    if (!ctx) throw new Error('SillyTavern context unavailable');
    return ctx;
}

/**
 * Get the current character's avatar identifier
 */
function getCharacterAvatar() {
    const context = getContext();
    return context.characters?.[context.characterId]?.avatar || null;
}

/**
 * Current chat id (the unique chat filename), or '' when none. Used ONLY to partition the
 * per-turn getAllDatabases() cache so a same-character chat-switch (where the avatar is
 * unchanged) cannot serve the previous chat's cached fact map. Storage itself stays
 * avatar-keyed; this is a cache-validity discriminator, never a storage key.
 * @returns {string}
 */
function getCurrentChatIdSafe() {
    try {
        const ctx = host.getCtx();
        return ctx?.getCurrentChatId?.() || ctx?.chatId || '';
    } catch {
        return '';
    }
}

// =============================================================================
// HYBRID PERSISTENCE LAYER (IndexedDB working store + attachment durable snapshot)
// =============================================================================
//
// MOTIVATION. Until now facts lived ONLY in SillyTavern character ATTACHMENTS
// (`bf_memory_db_<category>.json`), one file per category. Every read fetch()ed +
// JSON.parsed every category file, and every write re-uploaded a whole file (delete
// old + upload new). That is durable + device-independent (it travels with the ST
// backend) but slow and write-heavy.
//
// HYBRID MODEL (this phase):
//   * IndexedDB ("IDB") is the FAST WORKING STORE. All reads/writes that used to hit
//     attachments now go through IDB first. ONE IDB record PER CHARACTER AVATAR holds
//     the EXACT same { category: { facts:[...] } } map the rest of the code already
//     uses — so nothing downstream changes shape.
//   * The character ATTACHMENT(S) become a DURABLE, device-independent SNAPSHOT/BACKUP.
//     On a throttled cadence (and on meaningful flush points: chat change / beforeunload)
//     we serialize the IDB record back out to the SAME per-category attachment files via
//     the SAME uploadFileAttachment mechanism, so a new device / cleared browser / another
//     device can rehydrate from the backend.
//
// CONTRACT PRESERVED. The public API (getAllDatabases / saveDatabase / deleteDatabase /
// upsertFact / …) keeps its EXACT signatures + return shapes. The per-turn cache +
// invalidate-on-write contract is unchanged: a write invalidates the cache so the next
// read is fresh, and an IDB write is AWAITED+COMMITTED before that read can run.
//
// GRACEFUL FALLBACK (critical). EVERY IDB access is wrapped in try/catch behind a
// capability probe (idbAvailable()). If IndexedDB is missing, blocked (private mode), or
// throws, the layer transparently FALLS BACK to the ORIGINAL attachment-only paths
// (loadAllDatabasesFromAttachments / saveDatabaseToAttachment / the inline delete). A user
// with no usable IDB sees ZERO behavior change.
// =============================================================================

const IDB_NAME = 'bf_memory_pipeline';
const IDB_VERSION = 1;
const IDB_STORE = 'character_dbs';
// Schema version stamped into each IDB record + each snapshot payload, so a future migration
// can recognize an old on-disk shape. Bump only on a breaking record-shape change.
const SNAPSHOT_SCHEMA_VERSION = 1;

// redesign-v2 (S1): the opt-in USER-LEVEL SHARED MEMORY store (pseudo-avatar
// bf_shared_user_memory, mirror/merge/clearSharedUserMemory) was removed.

// Capability probe result is memoized: 'unknown' until first checked, then true/false.
let _idbCapable = 'unknown';
let _idbConnPromise = null; // shared open() promise (one connection for the page lifetime)
let _idbFallbackLogged = false; // so the fallback notice fires once per session, not per call

/**
 * Disable IndexedDB for the session and log the fallback ONCE (debug-logging standing rule),
 * so the user can SEE in the Debug tab that the extension is running on durable attachments
 * only (private mode / blocked / hard IDB error) instead of silently degrading.
 * @param {string} reason
 */
function disableIdb(reason) {
    _idbCapable = false;
    if (_idbFallbackLogged) return;
    _idbFallbackLogged = true;
    try {
        addDebugLog('info', `IndexedDB unavailable — using durable attachments only (${reason})`, {
            subsystem: 'db', event: 'storage.fallback', reason: 'IDB_UNAVAILABLE', data: { why: reason },
        });
    } catch { /* logging must never break storage */ }
}

/**
 * One-time capability probe: is IndexedDB usable here? False when the global is absent or
 * throws on access (some locked-down contexts). The real open() below also try/catches and
 * disables IDB on hard failures, so this is a fast pre-filter, not the only guard.
 * @returns {boolean}
 */
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

/**
 * Open (and lazily create/upgrade) the IDB connection. Shares ONE in-flight/resolved promise
 * for the whole page. REJECTS (and disables IDB for the session on hard errors) on any failure
 * so every caller falls back to attachments. Never throws synchronously.
 * @returns {Promise<IDBDatabase>}
 */
function openIdb() {
    if (!idbAvailable()) return Promise.reject(new Error('IndexedDB unavailable'));
    if (_idbConnPromise) return _idbConnPromise;
    _idbConnPromise = new Promise((resolve, reject) => {
        let req;
        try {
            req = indexedDB.open(IDB_NAME, IDB_VERSION);
        } catch (e) {
            disableIdb('open() threw'); // hard-disable for the session + log once
            reject(e);
            return;
        }
        req.onupgradeneeded = () => {
            try {
                const db = req.result;
                if (!db.objectStoreNames.contains(IDB_STORE)) {
                    // Keyed by character avatar (the same identifier used for attachments).
                    db.createObjectStore(IDB_STORE, { keyPath: 'avatar' });
                }
            } catch (e) {
                console.error('[BFMemory] IDB upgrade failed', e);
            }
        };
        req.onsuccess = () => {
            const db = req.result;
            // If the connection is ever force-closed (e.g. a version change from another tab),
            // drop the shared promise so the next call reopens cleanly.
            db.onversionchange = () => { try { db.close(); } catch { /* ignore */ } _idbConnPromise = null; };
            resolve(db);
        };
        req.onerror = () => { disableIdb('open error'); reject(req.error || new Error('IDB open error')); };
        req.onblocked = () => { reject(new Error('IDB open blocked')); };
    }).catch((e) => {
        // Reset so a later attempt can retry, but the memoized capability flag (set on hard
        // errors above) keeps us in attachment-only mode when IDB is genuinely unusable.
        _idbConnPromise = null;
        throw e;
    });
    return _idbConnPromise;
}

/**
 * Promise-wrap a single IDB transaction request. Resolves with request.result once the request
 * succeeds; rejects on request OR transaction error/abort.
 * @template T
 * @param {IDBDatabase} db
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => IDBRequest<T>} fn
 * @returns {Promise<T>}
 */
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

/**
 * Read the full IDB record for an avatar: { avatar, databases, updatedAt, schema } or null.
 * @param {string} avatar
 * @returns {Promise<{avatar:string, databases:Object, updatedAt:number, schema:number}|null>}
 */
async function idbGetRecord(avatar) {
    const db = await openIdb();
    const rec = await idbRequest(db, 'readonly', (store) => store.get(avatar));
    return rec || null;
}

/**
 * Write the full { category: { facts } } map for an avatar into IDB as ONE record, stamping
 * updatedAt + schema. The await resolves only AFTER the transaction commits, so a subsequent
 * idbGetRecord() in the next read is GUARANTEED to see this write (no stale-read-after-write).
 * @param {string} avatar
 * @param {Object<string, DatabaseSchema>} databases
 * @param {number} [updatedAt] - explicit timestamp (e.g. when adopting a snapshot's stamp)
 * @param {Object<string, number>} [deletedCategories] - optional category TOMBSTONES
 *   (`{ [category]: deletedAtMs }`, see deleteDatabase) carried on the record so the durable
 *   snapshot can propagate deliberate deletes across devices. Omitted/empty => field not stored
 *   (lean records; back-compat with pre-tombstone records is automatic — absent means none).
 * @returns {Promise<number>} the updatedAt actually written
 */
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

/**
 * ATOMIC read-modify-write of an avatar's full IDB record inside ONE readwrite transaction
 * (audit F-STOR-2). The previous pattern — idbGetRecord (its own readonly txn) followed by
 * idbPutDatabases (a second readwrite txn) — left a window where two concurrent writers to the
 * SAME avatar (e.g. a per-category save racing a delete or the shared-store mirror) could both
 * read the same base record and the second put would silently drop the first writer's category.
 * IndexedDB serializes readwrite transactions per store, so doing the get AND the put inside one
 * readwrite transaction makes the whole read-modify-write atomic: a concurrent updater's
 * transaction cannot interleave between our read and our write.
 *
 * The mutator runs synchronously inside the transaction (IDB requires it — an await would let
 * the txn auto-commit) with the CURRENT record (or null when none exists) and returns either:
 *   { databases, updatedAt?, deletedCategories? } → written as the new record (same field
 *       stamping as idbPutDatabases: updatedAt defaults to Date.now(), schema is stamped,
 *       deletedCategories stored only when non-empty), or
 *   null/undefined → NO write at all (record left byte-identical; no stamp bump).
 * The promise resolves only AFTER the transaction COMMITS (tx.oncomplete), preserving the
 * no-stale-read-after-write guarantee. A mutator throw aborts the transaction (nothing is
 * written) and rejects, so callers' existing catch/fallback paths behave exactly as before.
 * @param {string} avatar
 * @param {(rec: {avatar:string, databases:Object, updatedAt:number, schema:number, deletedCategories?:Object}|null)
 *   => ({databases:Object, updatedAt?:number, deletedCategories?:Object<string,number>}|null|undefined)} mutator
 * @returns {Promise<Object|null>} the record actually written, or null when the mutator skipped
 */
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
                    // put() in the SAME transaction — this is the atomicity fix. A put failure
                    // surfaces through tx.onerror/onabort below.
                    tx.objectStore(IDB_STORE).put(record);
                    written = record;
                }
            } catch (e) {
                try { tx.abort(); } catch { /* already aborting/aborted */ }
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

/**
 * Union two category-tombstone maps (`{ [category]: deletedAtMs }`), keeping the NEWEST stamp per
 * category. Used when adopting an attachment snapshot so tombstones learned from another device
 * merge with (never clobber) locally-recorded ones. Keys are category names, so the map stays
 * naturally tiny (bounded by the category count) — no pruning needed. Null-safe on both sides.
 * @param {Object<string, number>|null|undefined} a
 * @param {Object<string, number>|null|undefined} b
 * @returns {Object<string, number>}
 */
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

// =============================================================================
// DURABLE SNAPSHOT to attachments (throttled). The snapshot REUSES the existing per-category
// attachment layout (`bf_memory_db_<category>.json`) so it is fully backward/forward
// compatible: an older (attachment-only) build reads exactly these files, and the loader's
// legacy migration reads them too. We additionally stamp `updatedAt`/`snapshotVersion` into
// each file so the rehydrate logic can version-compare.
//
// CADENCE. Snapshotting every category file on every fact write would re-introduce the upload
// thrash we moved off of. So saveDatabase()/deleteDatabase() mark the avatar DIRTY + schedule a
// THROTTLED snapshot (SNAPSHOT_THROTTLE_MS). A meaningful flush point (CHAT_CHANGED /
// beforeunload) calls flushSnapshotNow() to force the tail out immediately.
// =============================================================================

const SNAPSHOT_THROTTLE_MS = 15000; // at most one full snapshot per dirty avatar every 15s
const _snapshotDirty = new Set();   // avatars with un-snapshotted IDB writes
const _snapshotTimers = new Map();  // avatar -> pending setTimeout id
let _snapshotInFlight = false;      // single-flight guard so two snapshots never overlap

/**
 * Mark an avatar's IDB state as needing a durable attachment snapshot and (re)arm the throttle
 * timer. No-op in attachment-only mode (writes are already durable). Never throws.
 * @param {string} avatar
 */
function scheduleSnapshot(avatar) {
    if (!avatar || !idbAvailable()) return;
    _snapshotDirty.add(avatar);
    if (_snapshotTimers.has(avatar)) return; // timer already armed; it picks up the dirty flag
    const id = setTimeout(() => {
        _snapshotTimers.delete(avatar);
        // Fire-and-forget; snapshotAvatar fully self-guards (a failed upload must never break the
        // pipeline — IDB still holds the authoritative working copy).
        snapshotAvatar(avatar).catch((e) => console.error('[BFMemory] snapshot failed', e));
    }, SNAPSHOT_THROTTLE_MS);
    _snapshotTimers.set(avatar, id);
}

/**
 * Serialize an avatar's IDB databases out to the per-category attachment files (durable backup).
 * Single-flight + best-effort: clears the dirty flag up-front so writes during the (slow) upload
 * re-mark it for the next pass. NEVER throws into callers.
 * @param {string} avatar
 * @param {{ reconcileDeletes?: boolean }} [options]
 * @param {boolean} [options.reconcileDeletes=true] - when true (default: USER-destructive flush
 *   cadence), remove durable attachment files for categories no longer live in IDB. When FALSE
 *   (chat-switch / beforeunload flush) we DO NOT delete durable files — a transiently-empty
 *   working store (e.g. mid chat-switch, before the new chat's facts load) must never escalate
 *   recoverable staleness into PERMANENT backup destruction. Only an emptied-by-WRITE category is
 *   ever reconciled away.
 * @returns {Promise<void>}
 */
async function snapshotAvatar(avatar, { reconcileDeletes = true } = {}) {
    if (!avatar || !idbAvailable()) return;
    if (_snapshotInFlight) { _snapshotDirty.add(avatar); return; } // coalesce; retry next tick
    if (!_snapshotDirty.has(avatar)) return;
    _snapshotInFlight = true;
    _snapshotDirty.delete(avatar);
    try {
        const rec = await idbGetRecord(avatar);
        if (!rec || !rec.databases) return;
        const stamp = Number(rec.updatedAt) || Date.now();
        // The set of categories that SHOULD have a durable attachment file after this snapshot
        // (i.e. categories that still hold ≥1 fact in IDB). Anything NOT in this set must have its
        // stale attachment file removed below — otherwise an emptied/cleared category leaves a
        // leftover file that the rehydrate path (loadAllDatabases CASE B) could read back.
        const liveCategories = new Set();
        // Write each POPULATED category to its own attachment file (existing layout). Empty
        // categories are skipped (matches the write-on-first-fact policy that kept the backend
        // from accumulating empty files).
        // TOMBSTONES (F-STOR-4, multi-device deletes): stamp the record's category delete-markers
        // (`deletedCategories: { [category]: deletedAtMs }`, written by deleteDatabase /
        // clearSharedUserMemory) into EVERY per-category payload. A deleted category has no file
        // of its own anymore, so the marker must ride the SURVIVING categories' files for another
        // device's rehydrate guard (loadAllDatabases CASE B) to see the delete was deliberate.
        // Absent/empty => field omitted (lean payloads; older builds simply ignore it).
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
        // RECONCILE DELETIONS (F4): remove attachment files for DB categories that no longer have
        // facts in IDB (emptied by clear/supersession or never re-written). Without this, an
        // emptied category's old attachment survives and can rehydrate the working store. We match
        // on the canonical `bf_memory_db_<slug>.json` shape and compare against the live slug set.
        //
        // DATA-SAFETY FIX (coordinated CHAT_CHANGED): reconcile is SKIPPED when reconcileDeletes is
        // false (a chat-switch / beforeunload flush). A chat-switch can transiently empty the shared
        // avatar working store (e.g. before the incoming chat's facts load); deleting durable backup
        // files in that window would turn recoverable staleness into PERMANENT loss with nothing left
        // to rehydrate from. Durable file removal happens only on a USER-destructive op (which calls
        // deleteDatabase — that removes the file inline — and/or flushes with reconcileDeletes:true).
        let reconciled = 0;
        if (reconcileDeletes) {
            reconciled = await reconcileDeletedAttachments(avatar, liveCategories);
        }
        addDebugLog('debug', 'Durable snapshot written (IDB → attachments)', {
            subsystem: 'db', event: 'db.snapshot',
            data: { updatedAt: stamp, liveCategories: liveCategories.size, attachmentsRemoved: reconciled, reconcileDeletes },
        });
    } catch (e) {
        _snapshotDirty.add(avatar); // re-mark so a later cadence retries; never propagate
        console.error('[BFMemory] snapshotAvatar failed', e);
    } finally {
        _snapshotInFlight = false;
    }
}

/**
 * Remove durable attachment files for DB categories that are NO LONGER live (no facts in IDB).
 * Used by snapshotAvatar to keep the attachment layer in lock-step with the IDB working store so
 * a cleared/emptied category cannot leave a leftover file that the rehydrate path reads back.
 * Matches every `bf_memory_db_*.json` attachment whose slug is not in `liveSlugs` and removes it
 * (file + array entry). Best-effort: a failed file delete still drops the stale array entry so the
 * loader stops merging it. Never throws.
 * @param {string} avatar
 * @param {Set<string>} liveSlugs - sanitized category slugs that SHOULD keep a file
 * @returns {Promise<number>} count of attachment entries removed
 */
async function reconcileDeletedAttachments(avatar, liveSlugs) {
    const context = getContext();
    const attachments = context.extensionSettings?.character_attachments?.[avatar];
    if (!Array.isArray(attachments) || attachments.length === 0) return 0;
    let removed = 0;
    // Iterate a snapshot of indices high→low so splices don't shift the ones we still inspect.
    for (let i = attachments.length - 1; i >= 0; i--) {
        const a = attachments[i];
        const name = a && a.name;
        if (typeof name !== 'string' || !name.startsWith(DB_PREFIX) || !name.endsWith('.json')) continue;
        const slug = name.slice(DB_PREFIX.length, -'.json'.length);
        if (liveSlugs.has(slug)) continue; // still backed by a populated category — keep it
        try {
            await deleteAttachmentFile(a.url);
        } catch { /* ignore — still drop the array entry below so the loader stops merging it */ }
        attachments.splice(i, 1);
        removed++;
    }
    if (removed > 0) context.saveSettingsDebounced?.();
    return removed;
}

/**
 * Cancel any ARMED throttled snapshot timer and clear the dirty flag for an avatar (defaults to
 * the current character). Exported so a USER-initiated destructive op (per-category delete / Clear
 * All) can guarantee that a snapshot armed by an earlier fact write does NOT fire afterward and
 * re-materialize a just-deleted category's attachment file. Safe to call repeatedly; never throws.
 * NOTE: this does not interrupt a snapshot already mid-upload (single-flight `_snapshotInFlight`);
 * destructive callers flush a fresh, reconciling snapshot afterward so the final durable state is
 * still the deleted/empty one.
 * @param {string} [avatar] - defaults to getCharacterAvatar()
 */
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

/**
 * Force an immediate durable snapshot of a character's IDB state to attachments.
 * Exported so the orchestrator can flush on a meaningful boundary (CHAT_CHANGED / beforeunload).
 * Best-effort: no-op in attachment-only mode (writes are already durable). Never throws.
 *
 * @param {{ avatar?: string, reconcileDeletes?: boolean }} [options]
 * @param {string} [options.avatar] - PIN a specific avatar to flush (the OUTGOING character on a
 *   coordinated chat-switch). Defaults to getCharacterAvatar() (the live character) for all the
 *   existing same-character call sites where the avatar is unchanged.
 * @param {boolean} [options.reconcileDeletes=true] - pass FALSE on a chat-switch/beforeunload flush
 *   so a transiently-empty working store can NOT delete durable backup files (see snapshotAvatar).
 *   USER-destructive flushes keep the default (true) so a real clear/delete still prunes leftovers.
 * @returns {Promise<void>}
 */
export async function flushSnapshotNow({ avatar: pinnedAvatar, reconcileDeletes = true } = {}) {
    try {
        if (!idbAvailable()) return;
        const avatar = pinnedAvatar || getCharacterAvatar();
        if (!avatar) return;
        if (_snapshotTimers.has(avatar)) { clearTimeout(_snapshotTimers.get(avatar)); _snapshotTimers.delete(avatar); }
        _snapshotDirty.add(avatar); // ensure snapshotAvatar runs even if no timer was armed
        await snapshotAvatar(avatar, { reconcileDeletes });
    } catch (e) {
        console.error('[BFMemory] flushSnapshotNow failed', e);
    }
}

// =============================================================================
// PER-TURN getAllDatabases() CACHE (perf). getAllDatabases() fetch()es + JSON.parses
// every category attachment, and it is called ~4-5×/turn (Drafter menu, speculative
// retrieval, finder, post-reply extraction, reflection/UI). Re-reading every category
// file that many times per turn is pure waste — the on-disk facts only change when WE
// write one. So we memoize the parsed result and serve it on subsequent calls, keyed by
// the current character avatar (a different character must never see a cached DB map).
//
// CORRECTNESS — the cache MUST be invalidated on ANY write so a post-write read is
// FRESH (extraction runs post-reply and DOES write; a stale read after a write would be
// a correctness bug — facts would silently disappear/reappear). Every write path funnels
// through saveDatabase()/deleteDatabase(), which call invalidateDatabaseCache(); the
// CHAT_CHANGED handler (pipeline.js) also invalidates so switching chats never serves a
// previous chat's facts. A pending in-flight fetch is shared (promise cache) so concurrent
// callers within one turn don't each kick off their own round of fetches.
//
// NOTE: getAllDatabases() returns a possibly-SHARED object reference (the cached map).
// Callers that mutate it in place (applyUpdates → upsertFact) then persist via
// saveDatabase(), which invalidates — so the next reader re-fetches fresh from disk. We
// never serve a mutated-but-unsaved map across a write boundary.
let _dbCache = null;          // resolved map (Object<string, DatabaseSchema>)
let _dbCacheAvatar = null;    // avatar the cached map belongs to
let _dbCacheChatId = null;    // chatId the cached map belongs to (same-character chat-switch guard)
let _dbCachePromise = null;   // in-flight load promise (deduped concurrent callers)

/**
 * Invalidate the per-turn getAllDatabases() cache. Called automatically on every write
 * (saveDatabase / deleteDatabase) and must also be called by the chat-change handler.
 * Safe to call repeatedly. Exported so the orchestrator can drop it on CHAT_CHANGED.
 */
export function invalidateDatabaseCache() {
    _dbCache = null;
    _dbCacheAvatar = null;
    _dbCacheChatId = null;
    _dbCachePromise = null;
    // The per-turn in-memory fact index is derived from the cached map, so it must be dropped
    // on the SAME invalidation boundary (write / chat-change) — otherwise an indexed query
    // could serve a stale (pre-write) candidate set. Cheap to rebuild lazily on next use.
    invalidateMemoryIndex();
}

/**
 * Get all memory databases for the current character. Memoized per-turn (see the cache
 * note above): returns the cached parsed map until a write or chat-change invalidates it.
 * @returns {Promise<Object<string, DatabaseSchema>>} Map of category -> database
 */
export async function getAllDatabases() {
    const avatar = getCharacterAvatar();
    if (!avatar) return {};
    // Partition the cache by (avatar, chatId) as well: a same-character chat-switch keeps the
    // avatar unchanged, so without the chatId discriminator the avatar-only validity check would
    // serve the PREVIOUS chat's cached map to the new chat's first turn (stale fact set). Storage
    // remains avatar-keyed — this only governs cache validity / the in-flight commit guard.
    const chatId = getCurrentChatIdSafe();

    // Serve the cache only when it belongs to the CURRENT character AND chat (a character OR a
    // same-character chat switch must never leak another context's facts).
    if (_dbCache && _dbCacheAvatar === avatar && _dbCacheChatId === chatId) return _dbCache;
    // Share an in-flight load so concurrent callers in the same turn don't each re-fetch.
    if (_dbCachePromise && _dbCacheAvatar === avatar && _dbCacheChatId === chatId) return _dbCachePromise;

    _dbCacheAvatar = avatar;
    _dbCacheChatId = chatId;
    _dbCachePromise = (async () => {
        try {
            const result = await loadAllDatabases(avatar);
            // Only commit to the cache if neither the avatar NOR the chatId changed under us mid-load
            // and the cache wasn't invalidated (a write/switch during the fetch nulls the keys). This
            // stops a load started under chat A from committing under chat B (same character).
            if (_dbCacheAvatar === avatar && _dbCacheChatId === chatId) _dbCache = result;
            return result;
        } finally {
            // Clear the in-flight marker only if it's still ours.
            if (_dbCacheAvatar === avatar && _dbCacheChatId === chatId) _dbCachePromise = null;
        }
    })();
    return _dbCachePromise;
}

// =============================================================================
// PER-TURN IN-MEMORY FACT INDEX (scaling fix). The hot retrieval paths
// (collectBranchFacts / searchFacts / summarizeMenu) used to SCAN EVERY fact in the
// whole databases map on every call — O(all-facts) per call, several calls per turn.
// With the 50-fact cap removed (infinite cold-tiered facts), a category can hold tens of
// thousands of facts, so that scan is the scaling bottleneck.
//
// CHOICE — IN-MEMORY INDEX (not a per-fact IDB object store). The persistence layer keeps
// its ONE-record-per-avatar shape (the whole { category:{facts:[]} } map), so the durable
// snapshot, the IDB-unavailable fallback, the cold-tier RMW, and dedupeDatabase all stay
// EXACTLY as they were — zero migration, zero new failure modes. Instead, the FIRST indexed
// query in a turn builds three lookup maps ONCE from the already-cached map and memoizes them
// keyed by avatar; subsequent lookups are O(matching facts). The index is invalidated on the
// SAME boundary as the DB cache (any write / chat-change), so it can never serve a stale set.
// Building the index is one O(all-facts) pass per turn (replacing the SEVERAL O(all) scans the
// hot paths each did), and it is skipped entirely when no indexed query runs that turn.
//
// FALLBACK NOTE: nothing here touches IDB or attachments. When IDB is unavailable the index is
// simply built from the attachment-loaded map (getAllDatabases already abstracts that), so the
// fallback path benefits from the same speedup with no special-casing.
// =============================================================================

let _idxCache = null;        // { byCatAspect, bySubject, byToken, aspectCounts, totalFacts }
let _idxCacheAvatar = null;  // avatar the index belongs to

/** Drop the memoized per-turn fact index (called by invalidateDatabaseCache). */
export function invalidateMemoryIndex() {
    _idxCache = null;
    _idxCacheAvatar = null;
}

/**
 * Tokenize a fact's searchable text (key + value + tags + aliases) into lowercased word
 * tokens via the SHARED Unicode tokenizer (ASCII keeps the legacy length > 3 gate). This is
 * the INDEX side; every query side (searchFactsIndexed / scopedScribeCandidates / expansion)
 * routes through the same wordTokens so index and query tokens can never diverge. Character-
 * name words are NOT filtered here (they're filtered at query time, where the current names
 * are known); the index is name-agnostic so it survives a mid-chat rename.
 * @param {FactSchema} fact
 * @returns {string[]} unique tokens
 */
function factTokens(fact) {
    const text = `${fact.key || ''} ${fact.value || ''} ${(fact.tags || []).join(' ')} ${(fact.aliases || []).join(' ')}`;
    return wordTokens(text);
}

/**
 * Build the in-memory fact index from a databases map (pure; no IDB/attachment access). Indexes
 * ONLY active facts (superseded history is never a retrieval target, matching every hot path's
 * `isActiveFact` guard) into:
 *   - byCatAspect: Map(`category||aspect` -> [{fact, category}])  — for collectBranchFacts.
 *   - bySubject:   Map(subject -> [{fact, category}])              — subject-scoped narrowing.
 *   - byToken:     Map(token -> [{fact, category}])                — for searchFacts keyword hits.
 *   - aspectCounts: Map(category -> Map(aspect -> count of active HOT facts)) — for summarizeMenu.
 * Lowercased category in byCatAspect keys (callers normalize the same way). The same fact object
 * reference is shared across buckets (no copies) so downstream cold-resurrection mutations still
 * hit the real stored object.
 * @param {Object<string, DatabaseSchema>} databases
 * @returns {{byCatAspect: Map, bySubject: Map, byToken: Map, aspectCounts: Map, totalFacts: number}}
 */
export function buildMemoryIndex(databases) {
    const byCatAspect = new Map();
    const bySubject = new Map();
    const byToken = new Map();
    const bySceneNo = new Map(); // Spiderweb 2: sceneNo -> [{fact, category}] (the in-scene strand)
    const aspectCounts = new Map();
    let totalFacts = 0;

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
            if (!isActiveFact(fact)) continue; // index only currently-valid facts
            totalFacts++;
            const entry = { fact, category };
            const aspect = deriveAspect(fact);
            add(byCatAspect, `${catLower}||${aspect}`, entry);
            add(bySubject, deriveSubject(fact), entry);
            for (const tok of factTokens(fact)) add(byToken, tok, entry);
            // In-scene strand (Spiderweb 2): bucket the fact under its origin scene number so the
            // unified expansion can pull same-scene facts (capped, candidacy-only) and getFactsByScene
            // can recall a whole scene. Keyed by the numeric sceneNo (back-compat: facts without one
            // are simply absent from this bucket).
            if (Number.isInteger(fact.sceneNo) && fact.sceneNo >= 1) add(bySceneNo, fact.sceneNo, entry);
            // Menu counts: active HOT facts only (cold-tiered overflow is hidden from the planner).
            if (isHotFact(fact)) {
                let m = aspectCounts.get(category);
                if (!m) { m = new Map(); aspectCounts.set(category, m); }
                m.set(aspect, (m.get(aspect) || 0) + 1);
            }
        }
    }
    return { byCatAspect, bySubject, byToken, bySceneNo, aspectCounts, totalFacts };
}

/**
 * Get the per-turn in-memory fact index for the CURRENT character, building it ONCE from the
 * cached databases map and memoizing it (keyed by avatar, invalidated on any write/chat-change).
 * Loads the map via getAllDatabases() (which already serves the per-turn cache or the attachment
 * fallback), so this works identically with or without IDB.
 * @returns {Promise<{byCatAspect: Map, bySubject: Map, byToken: Map, bySceneNo: Map, aspectCounts: Map, totalFacts: number}>}
 */
export async function getMemoryIndex() {
    const avatar = getCharacterAvatar();
    if (_idxCache && _idxCacheAvatar === avatar) return _idxCache;
    const databases = await getAllDatabases();
    // Re-check: getAllDatabases may have been awaited across a boundary; only commit if still ours.
    const idx = buildMemoryIndex(databases);
    if (getCharacterAvatar() === avatar) {
        _idxCache = idx;
        _idxCacheAvatar = avatar;
    }
    return idx;
}

/**
 * Normalize a branch pick / category token: strip wrapping punctuation Agent 1 may add, lowercase.
 * Shared by the indexed collectBranchFacts so its parsing matches the legacy scan exactly.
 */
function normBranchToken(s) {
    return String(s ?? '')
        .trim()
        .replace(/^[\s\-*•"'`(\[\{]+/, '')
        .replace(/[\s.,;:"'`)\]\}]+$/, '')
        .trim()
        .toLowerCase();
}

/**
 * INDEXED collectBranchFacts (scaling fix). Same contract/return shape as collectBranchFacts but
 * resolves Agent 1's branch picks via the prebuilt index instead of scanning every fact:
 *   - `Category` (no slash)  -> union of all that category's `category||aspect` buckets.
 *   - `Category/aspect`      -> just that one bucket.
 *   - Unsorted               -> ALWAYS included (every aspect under it), as before.
 * Active-only (the index already excludes inactive), deduped by `category:key`. The work is
 * O(facts in the picked branches + Unsorted), not O(all facts). Logs `retrieval.indexed`.
 * @param {{byCatAspect: Map, aspectCounts: Map}} index
 * @param {string[]} branches
 * @returns {Array<{fact: Object, category: string}>}
 */
export function collectBranchFactsIndexed(index, branches) {
    const out = [];
    const seen = new Set();
    const push = (entry) => {
        const id = `${entry.category}:${entry.fact.key}`;
        if (seen.has(id)) return;
        seen.add(id);
        out.push(entry);
    };

    // Which category||aspect buckets do we want? Parse picks into wanted whole-cats + cat/aspect.
    const wantWholeCat = new Set();   // lowercased category names
    const wantCatAspect = new Set();  // `cat||aspect` lowercased
    for (const raw of (branches || [])) {
        const s = String(raw ?? '');
        const slashIdx = s.indexOf('/');
        if (slashIdx < 0) {
            const cat = normBranchToken(s);
            if (cat) wantWholeCat.add(cat);
        } else {
            const cat = normBranchToken(s.slice(0, slashIdx));
            const asp = normBranchToken(s.slice(slashIdx + 1));
            if (cat && asp) wantCatAspect.add(`${cat}||${asp}`);
            else if (cat) wantWholeCat.add(cat);
        }
    }
    // Unsorted is ALWAYS included (catch-all), as in the original scan.
    wantWholeCat.add('unsorted');

    // Iterate ONLY the index buckets (each key is `category||aspect`); admit a bucket when its
    // category is wanted whole OR the exact cat/aspect pair was picked. This visits only populated
    // buckets, and only the wanted ones — never the full fact set.
    let byIndex = true;
    for (const [bucketKey, entries] of index.byCatAspect) {
        const sep = bucketKey.indexOf('||');
        const cat = bucketKey.slice(0, sep);
        if (wantWholeCat.has(cat) || wantCatAspect.has(bucketKey)) {
            for (const e of entries) push(e);
        }
    }

    addDebugLog('debug', `Indexed branch collect: ${out.length} candidate(s) from ${wantWholeCat.size} whole-cat + ${wantCatAspect.size} cat/aspect pick(s)`, {
        subsystem: 'retrieval', event: 'retrieval.indexed',
        data: { byIndex, candidateCount: out.length, op: 'collectBranchFacts', wholeCats: wantWholeCat.size, catAspects: wantCatAspect.size },
    });
    return out;
}

/**
 * INDEXED searchFacts (scaling fix). Resolves keyword hits via the prebuilt token index instead
 * of scanning every fact, then runs the EXACT same per-fact ranking/tiering/expansion the
 * original searchFacts did — over the SMALL candidate set the index returned. Keeps cold
 * deprioritization, relationship secondary/tertiary tiers, the primary cap, and relationship
 * expansion. Returns the same `{fact, category, tier}[]` shape. Logs `retrieval.indexed`.
 *
 * CANDIDATE SET = a SUPERSET of what the original full scan could match, so recall is preserved.
 * The original tested `factText.includes(word)` (a SUBSTRING test), so a keyword word could match
 * inside a longer fact token ("part" in "apartment") or equal it. We therefore gather every fact
 * whose token EQUALS, CONTAINS, or is CONTAINED BY a keyword word. We iterate the index's distinct
 * tokens (far fewer than total facts) once per keyword word to find those — still well below the
 * old O(all-facts) per call. PLUS facts whose category name matches a keyword word (the original
 * matched on `categoryLower.includes(word)` too). The exact same per-fact ranking then re-applies
 * the precise `includes` test over this candidate set, so no false positives leak through.
 * @param {{byToken: Map}} index
 * @param {Object<string, DatabaseSchema>} databases - still passed for the bounded relationship
 *   expansion (which walks linked refs); the keyword match itself no longer scans it.
 * @param {string[]} keywords
 * @returns {Array<{fact: Object, category: string, tier: string}>}
 */
export function searchFactsIndexed(index, databases, keywords) {
    const MAX_PRIMARY = 8;
    const results = [];
    const nameWords = getCharacterNameWords();
    const lowerKeywords = keywords.map(k => k.toLowerCase());

    // Same keyword pre-processing as the original, via the SHARED tokenizer (same function as
    // the index side, so a non-ASCII keyword yields exactly the tokens byToken is keyed by):
    // split into words, drop char-name words (short words are gated inside wordTokens).
    const keywordWordSets = lowerKeywords.map(kw =>
        wordTokens(kw).filter(w => !nameWords.has(w))
    ).filter(words => words.length > 0);

    // Gather the candidate set from the token index. Match a keyword word against an index token
    // when either CONTAINS the other (superset of the original's substring `includes` test), so
    // "part"~"apartment" and "apartments"~"apartment" both qualify. Exact hits use the O(1) Map
    // get; the contains/contained pass iterates distinct tokens (« total facts).
    const candidates = new Map(); // `category:key` -> {fact, category}
    const allKeyWords = new Set();
    for (const words of keywordWordSets) for (const w of words) allKeyWords.add(w);
    const pullBucket = (tok) => {
        const bucket = index.byToken.get(tok);
        if (bucket) for (const e of bucket) candidates.set(`${e.category}:${e.fact.key}`, e);
    };
    for (const word of allKeyWords) pullBucket(word); // exact hits (fast path)
    // Substring/superstring hits: scan distinct tokens once. Only needed for words that could
    // match a DIFFERENT-length token (the exact pass already handled equality).
    for (const token of index.byToken.keys()) {
        for (const word of allKeyWords) {
            if (token === word) continue; // exact already pulled
            if (token.includes(word) || word.includes(token)) { pullBucket(token); break; }
        }
    }
    // Also admit facts whose CATEGORY name contains a keyword word (the original matched on
    // `categoryLower.includes(word)` too). Categories are few, so this stays cheap.
    for (const cat of collectCategoriesFromIndex(index)) {
        const catLower = cat.toLowerCase();
        const catHit = keywordWordSets.some(words => words.some(w => catLower.includes(w)));
        if (!catHit) continue;
        // pull every active fact of that category from the index buckets
        for (const [bucketKey, entries] of index.byCatAspect) {
            if (bucketKey.slice(0, bucketKey.indexOf('||')) !== catLower) continue;
            for (const e of entries) candidates.set(`${e.category}:${e.fact.key}`, e);
        }
    }

    const candidateList = [...candidates.values()];

    // Now run the SAME per-fact matching/tiering as the original, but over candidates only.
    for (const { fact, category } of candidateList) {
        const categoryLower = category.toLowerCase();
        // (index already filtered to active facts)
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

    // Primary cap + COLD-FIRST demotion — identical to the original.
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

    // Relationship-based expansion (bounded). The original re-scanned every fact for refs that
    // point at a primary hit; we instead resolve refs through the token index (a ref token pulls
    // the small set of facts mentioning it), keeping it O(refs * matches) rather than O(all).
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
            // A ref names a key/tag/category token; pull candidates by each word of it
            // (shared tokenizer — same tokens the index is keyed by).
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

/** Collect the distinct (original-cased) category names present in the index. */
function collectCategoriesFromIndex(index) {
    const seen = new Set();
    const cats = [];
    for (const entries of index.byCatAspect.values()) {
        for (const e of entries) {
            if (!seen.has(e.category)) { seen.add(e.category); cats.push(e.category); }
        }
        // one entry per bucket is enough to learn the category
    }
    return cats;
}

/**
 * INDEXED summarizeMenu counts (scaling fix). Builds the same planner menu as summarizeMenu but
 * reads per-aspect ACTIVE-HOT counts from the prebuilt index's aspectCounts aggregate instead of
 * walking every fact. Same output: one populated category per line, populated aspects in fixed
 * vocab order then out-of-vocab extras by count, empty categories omitted. Logs `retrieval.indexed`.
 * @param {{aspectCounts: Map}} index
 * @returns {string}
 */
export function summarizeMenuIndexed(index) {
    // Use the canonical L1 order first, then any custom categories that have counts.
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
        const vocab = aspectVocabFor(name);
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

/**
 * SCOPED scribe-dedup candidates (the key unbounded fix). For the message being processed, return
 * ONLY the active facts that could plausibly be duplicates/relevant — those sharing a SUBJECT or a
 * keyword TOKEN with the message — via the prebuilt index, bounded to `cap`. This replaces dumping
 * the WHOLE active DB into the Scribe prompt. The write-time reconcile (findParallelStateKey /
 * findFactMatch / upsertFact) remains the dedup AUTHORITY; this only narrows what the prompt SHOWS.
 *
 * Selection: union of (a) facts whose subject matches a subject token in play and (b) facts sharing
 * a >3-char keyword token with the message, deduped by `category:key`. Capped to the highest-
 * salience `cap` candidates so the prompt stays bounded on a huge store. Logs `scribe.dedup_scoped`.
 * @param {{bySubject: Map, byToken: Map}} index
 * @param {string[]} subjects - subject tokens in play (e.g. {{char}}, {{user}}, named entities)
 * @param {string[]} keywords - keyword/token hints from the message text
 * @param {number} [cap=60] - max scoped candidates to include
 * @returns {Array<{fact: Object, category: string}>}
 */
export function scopedScribeCandidates(index, subjects, keywords, cap = 60) {
    const picked = new Map(); // `category:key` -> {fact, category}
    const addEntry = (e) => { if (e) picked.set(`${e.category}:${e.fact.key}`, e); };

    for (const subj of (subjects || [])) {
        const s = String(subj || '').trim().toLowerCase();
        if (!s) continue;
        const bucket = index.bySubject.get(s);
        if (bucket) for (const e of bucket) addEntry(e);
    }
    for (const kw of (keywords || [])) {
        for (const w of wordTokens(kw)) { // shared tokenizer — matches the byToken index keys
            const bucket = index.byToken.get(w);
            if (bucket) for (const e of bucket) addEntry(e);
        }
    }

    let candidates = [...picked.values()];
    // Bound the set: rank by salienceScore (importance + recency + use bonus), which applies a COLD
    // penalty that sinks cold-tiered facts below every hot fact, then keep the top cap.
    if (candidates.length > cap) {
        const now = Date.now();
        candidates = candidates
            .slice()
            .sort((a, b) => salienceScore(b.fact, now, true) - salienceScore(a.fact, now, true))
            .slice(0, cap);
    }
    return candidates;
}

/**
 * Uncached loader (HYBRID orchestrator). Decides where the authoritative working copy lives and
 * returns the SAME { category -> DatabaseSchema } map shape callers already expect. Split out of
 * getAllDatabases() so the per-turn cache wrapper above can memoize it.
 *
 * FLOW (IDB available):
 *   1) Read the IDB record for this avatar AND the attachment snapshot (the latter is the same
 *      fetch+parse the legacy path does, run once here as both the snapshot reader and fallback).
 *   2) VERSION-COMPARE by updatedAt:
 *        - No IDB record but attachments hold facts  → MIGRATE: seed IDB from attachments once,
 *          return that map (new device / first run after upgrade / legacy install).
 *        - Attachment snapshot stamp NEWER than IDB  → REHYDRATE IDB from the snapshot, return it
 *          (another device wrote a newer snapshot, or local IDB is empty/stale).
 *        - IDB present and >= snapshot               → IDB is authoritative; return IDB (it
 *          snapshots back out on the next write cadence).
 *   3) On ANY IDB error → fall back to the pure attachment loader (no behavior change).
 *
 * FLOW (IDB unavailable): straight passthrough to loadAllDatabasesFromAttachments — the EXACT
 * original behavior, so a user with no usable IDB sees zero regression.
 * @param {string} avatar
 * @returns {Promise<Object<string, DatabaseSchema>>}
 */
async function loadAllDatabases(avatar) {
    if (!avatar) return {};

    // LEGACY HYGIENE: strip pre-v0.31 inline `fact.embedding` vectors (10-30KB/fact) from a
    // loaded map — nothing reads them, they just bloat every snapshot/save.
    const stripLegacyEmbeddings = (map) => {
        for (const db of Object.values(map || {})) {
            for (const fact of (db?.facts || [])) delete fact.embedding;
        }
        return map;
    };

    // FALLBACK PATH: no usable IDB → original attachment-only behavior, unchanged.
    if (!idbAvailable()) {
        return loadAllDatabasesFromAttachments(avatar);
    }

    try {
        const rec = await idbGetRecord(avatar);
        const idbStamp = rec ? (Number(rec.updatedAt) || 0) : -1; // -1 = no IDB record at all
        const idbHasData = !!(rec && rec.databases && Object.keys(rec.databases).length > 0);

        // Read the attachment snapshot once (legacy loader; also performs the legacy
        // category/aspect remap). Its newest stamp drives the version compare. The meta collector
        // gathers any category delete-TOMBSTONES stamped into the payloads by another device's
        // snapshotAvatar (F-STOR-4) so the clobber guard below can honor deliberate deletes.
        const attachMeta = { deletedCategories: {} };
        const attachMap = await loadAllDatabasesFromAttachments(avatar, attachMeta);
        const attachTombs = attachMeta.deletedCategories || {};
        const attachStamp = attachmentSnapshotStamp(avatar, attachMap);
        const attachHasData = Object.keys(attachMap).some(c => (attachMap[c]?.facts || []).length > 0);

        // Observability: cheap before/after fact+category census of the two maps involved in a
        // migrate/rehydrate. "before" = the IDB state about to be replaced; "after" = the
        // attachment data adopted in. Seeing before<after (e.g. 5 -> 65) flags a clobber where an
        // OLDER snapshot was pulled over newer working data. Read-only — no behavior change.
        const countCats = (m) => (m && typeof m === 'object') ? Object.keys(m).length : 0;
        const countFacts = (m) => {
            if (!m || typeof m !== 'object') return 0;
            let n = 0;
            for (const k of Object.keys(m)) n += (m[k]?.facts || []).length;
            return n;
        };
        const idbDatabases = (rec && rec.databases) ? rec.databases : {};

        // CASE A — MIGRATION: no IDB record yet, but attachments hold facts. Seed IDB ONCE,
        // adopting the snapshot stamp so a later device compare is meaningful. Serve attachments.
        if (idbStamp < 0 && attachHasData) {
            // Carry any snapshot tombstones into the seeded record so this device keeps
            // re-emitting them in its own snapshots (F-STOR-4 propagation).
            await idbPutDatabases(avatar, attachMap, attachStamp || Date.now(), attachTombs);
            addDebugLog('info', 'Migrated legacy attachment DBs into IndexedDB', {
                subsystem: 'db', event: 'db.migrated', data: {
                    categories: Object.keys(attachMap).length,
                    avatar,
                    attachStamp, idbStamp,
                    // before = IDB being replaced (none here: idbStamp<0); after = adopted attachment data.
                    categoriesBefore: countCats(idbDatabases), factsBefore: countFacts(idbDatabases),
                    categoriesAfter: countCats(attachMap), factsAfter: countFacts(attachMap),
                },
            });
            return attachMap;
        }

        // CASE B — REHYDRATE: the attachment snapshot is strictly NEWER than IDB (another device,
        // or local IDB empty/stale). Adopt the snapshot into IDB and serve it.
        //
        // Strict `>` is required: on an EQUAL stamp the IDB working store is authoritative and we
        // fall through to CASE C (a clean flush makes attachStamp == idbStamp, so a no-op rehydrate
        // must never fire). The version stamp is now the logical data version (attachmentSnapshotStamp
        // no longer folds in file upload time), so `attachStamp > idbStamp` should only be true for a
        // genuinely newer snapshot.
        if (attachHasData && attachStamp > idbStamp) {
            // CLOBBER GUARD (data-safety), PER-CATEGORY + TOMBSTONE-AWARE (F-STOR-4). Even when
            // the stamp says the attachment is newer, a rehydrate must never SHRINK a live
            // category — that is the signature of a stale/partial snapshot (a sibling chat's
            // older flush, a snapshot captured mid-clear) resurrecting old state over fresh work.
            // The old guard compared ONE GLOBAL total, which had two failure modes:
            //   (a) one stale category could veto adopting every other (genuinely newer) category;
            //   (b) a DELIBERATE delete on device A shrank the total, so device B refused the
            //       snapshot and then RESURRECTED the deleted category via its own next snapshot.
            // Now each category decides for itself:
            //   - attachment count >= local count            → safe (grew/equal) — adopt it;
            //   - shrunk, but the snapshot carries a DELETE TOMBSTONE for the category that is
            //     NEWER than the local category's last activity → deliberate cross-device delete
            //     — adopt the smaller/absent snapshot state;
            //   - shrunk with NO authorizing tombstone       → genuine staleness — KEEP the local
            //     category (protective behavior preserved), while still adopting the rest.
            // Local + snapshot tombstones merge (newest per category) into the adopted record so
            // they keep propagating through this device's own snapshots.
            const mergedTombs = mergeTombstones(rec && rec.deletedCategories, attachTombs);
            if (idbHasData) {
                // Most-recent local activity in a category: the db-level updatedAt or the newest
                // fact lastUpdated, whichever is later (older payloads may lack either field).
                const categoryRecency = (sdb) => {
                    let max = Number(sdb?.updatedAt) || 0;
                    for (const f of (sdb?.facts || [])) {
                        const u = Number(f?.lastUpdated) || 0;
                        if (u > max) max = u;
                    }
                    return max;
                };
                const refusedCats = [];    // shrunk, no authorizing tombstone → keep local version
                const adoptedDeletes = []; // shrunk, tombstone newer than local activity → adopt
                for (const [cat, sdb] of Object.entries(idbDatabases)) {
                    const localCount = (sdb && Array.isArray(sdb.facts)) ? sdb.facts.length : 0;
                    if (localCount === 0) continue; // nothing to protect
                    const attachCount = (attachMap[cat] && Array.isArray(attachMap[cat].facts)) ? attachMap[cat].facts.length : 0;
                    if (attachCount >= localCount) continue; // grew/equal — adopt freely
                    const tomb = Number(attachTombs[cat]) || 0;
                    if (tomb > categoryRecency(sdb)) adoptedDeletes.push(cat);
                    else refusedCats.push(cat);
                }
                if (refusedCats.length > 0) {
                    // PARTIAL ADOPT: take the snapshot wholesale EXCEPT the refused categories,
                    // which keep their richer local version. Stamped with the snapshot's stamp so
                    // an unchanged snapshot can't re-fire CASE B on the next load.
                    const merged = { ...attachMap };
                    for (const cat of refusedCats) merged[cat] = idbDatabases[cat];
                    await idbPutDatabases(avatar, merged, attachStamp, mergedTombs);
                    addDebugLog('info', 'Rehydrate partially refused: kept local categories the snapshot would SHRINK (clobber guard)', {
                        subsystem: 'db', event: 'db.rehydrated', actor: 'SYSTEM', reason: 'CLOBBER_GUARD',
                        data: {
                            attachStamp, idbStamp, avatar, decision: 'PARTIAL_ADOPT',
                            refusedCategories: refusedCats, tombstoneDeletes: adoptedDeletes,
                            // before = live IDB; after = the merged map actually adopted.
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
            await idbPutDatabases(avatar, attachMap, attachStamp, mergedTombs);
            addDebugLog('info', 'Rehydrated IndexedDB from newer attachment snapshot', {
                subsystem: 'db', event: 'db.rehydrated', actor: 'SYSTEM', reason: 'NEWER_SNAPSHOT',
                data: {
                    attachStamp, idbStamp, avatar, decision: 'ADOPT_ATTACHMENT',
                    // before = IDB state being overwritten; after = attachment data rehydrated in.
                    // before > after means an OLD snapshot clobbered newer working data.
                    categoriesBefore: countCats(idbDatabases), factsBefore: countFacts(idbDatabases),
                    categoriesAfter: countCats(attachMap), factsAfter: countFacts(attachMap),
                },
            });
            return attachMap;
        }

        // CASE C — IDB is authoritative (present and >= snapshot, or attachments empty). Serve IDB;
        // a genuinely empty store returns {} (skeleton is layered on by callers via withSkeleton).
        if (idbHasData) return stripLegacyEmbeddings(rec.databases);
        return {};
    } catch (e) {
        // ANY IDB failure → transparent fallback to the original attachment-only loader.
        console.error('[BFMemory] IDB load failed; falling back to attachments', e);
        disableIdb('IDB load failed mid-session'); // stop hammering a broken IDB + log once
        return loadAllDatabasesFromAttachments(avatar);
    }
}

/**
 * Compute the snapshot "version" stamp for an avatar's attachment files. This is the LOGICAL
 * data version, NOT a file-landing time.
 *
 * DATA-SAFETY FIX (version stamp): we use ONLY the max embedded `db.updatedAt` (the value baked
 * into the payload by snapshotAvatar at the moment the DATA changed). We deliberately do NOT fold
 * in the attachment file `created` time — that is set to `Date.now()` at UPLOAD COMPLETION, which
 * on the throttled snapshot path is up to SNAPSHOT_THROTTLE_MS (15s) AFTER the data was actually
 * made. Folding `created` in let a snapshot of OLD data that merely finished uploading recently
 * win a `>` compare and clobber the FRESH IDB working store (the observed 15,569ms ≈ throttle gap).
 *
 * After a clean flush, snapshotAvatar stamps the payload `updatedAt` == the IDB record's
 * `updatedAt`, so `attachStamp === idbStamp` and the rehydrate (CASE B) cannot spuriously fire.
 *
 * LEGACY FALLBACK: `created` is consulted ONLY for genuinely stampless legacy files (none of the
 * parsed DBs carried an embedded `updatedAt`). Even then it can only RAISE a still-zero stamp; it
 * can never exceed a real embedded data version. Returns 0 when there are no DB attachments.
 * @param {string} avatar
 * @param {Object<string, DatabaseSchema>} parsedMap - already-parsed attachment DB map
 * @returns {number}
 */
function attachmentSnapshotStamp(avatar, parsedMap) {
    let max = 0;
    let sawEmbeddedStamp = false;
    for (const db of Object.values(parsedMap || {})) {
        const u = Number(db?.updatedAt) || 0;
        if (u > 0) sawEmbeddedStamp = true;
        if (u > max) max = u;
    }
    // LEGACY ONLY: if NO parsed DB carried an embedded logical `updatedAt`, fall back to the
    // file `created` time so a truly stampless legacy snapshot can still migrate/rehydrate once.
    // We never mix `created` with a real embedded stamp — the upload-completion time is a landing
    // time, not a data version, and mixing it is exactly the bug that clobbered fresh data.
    if (!sawEmbeddedStamp) {
        try {
            const context = getContext();
            const attachments = context.extensionSettings?.character_attachments?.[avatar] || [];
            for (const a of attachments) {
                if (!a.name?.startsWith(DB_PREFIX)) continue;
                const c = Number(a.created) || 0;
                if (c > max) max = c;
            }
        } catch { /* ignore */ }
    }
    return max;
}

/**
 * Pure ATTACHMENT loader (the ORIGINAL loadAllDatabases body, unchanged): fetch + parse +
 * legacy-remap every category attachment for a character. This is BOTH the fallback path (IDB
 * unavailable/broken) AND the snapshot reader used by the hybrid orchestrator above.
 * @param {string} avatar
 * @param {{deletedCategories?: Object<string, number>}} [meta] - optional OUT-collector. When the
 *   hybrid orchestrator passes it, every parsed payload's `deletedCategories` tombstone map
 *   (stamped by snapshotAvatar) is merged into `meta.deletedCategories` (newest stamp per
 *   category wins) so the rehydrate guard can honor cross-device deletes. Fallback callers omit
 *   it — zero behavior change on the attachment-only path.
 * @returns {Promise<Object<string, DatabaseSchema>>}
 */
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
                // TOMBSTONE COLLECTION (F-STOR-4): surface each payload's `deletedCategories`
                // markers to the hybrid orchestrator (newest deletedAtMs per category wins across
                // files). Only runs when a collector was passed; the returned databases map shape
                // is untouched.
                if (meta && db.deletedCategories && typeof db.deletedCategories === 'object'
                    && !Array.isArray(db.deletedCategories)) {
                    if (!meta.deletedCategories) meta.deletedCategories = {};
                    for (const [cat, ts] of Object.entries(db.deletedCategories)) {
                        const t = Number(ts) || 0;
                        if (t > (Number(meta.deletedCategories[cat]) || 0)) meta.deletedCategories[cat] = t;
                    }
                }
                // BACK-COMPAT (3-layer model): a DB stored under an OLD category name
                // (Identity/Status/Behavior/History) is re-bucketed onto the new Layer-1
                // set on read. We remap PER-FACT (scope-sensitive) and merge into the
                // canonical category — old Identity+Behavior+Status all fold into People,
                // History into Events, etc. — so existing chats keep working without a
                // migration write. New-category DBs map to themselves (no-op).
                for (const fact of (db.facts || [])) {
                    delete fact.embedding; // legacy pre-v0.31 inline vectors (10-30KB/fact); nothing reads them
                    const target = mapLegacyCategory(db.category, fact);
                    // Stamp the per-fact category so deriveScope/aspect and the menu read the
                    // resolved Layer-1 home (the fact may diverge from the file's category when
                    // a scope-sensitive remap split a legacy bucket).
                    if (target !== db.category) {
                        addDebugLog('debug', `Legacy category remap: ${db.category} → ${target} (${fact.key})`, {
                            subsystem: 'db', event: 'fact.remapped', reason: 'LEGACY_CATEGORY_REMAP',
                            data: { key: fact.key }, before: db.category, after: target,
                        });
                    }
                    fact.category = target;
                    if (!databases[target]) databases[target] = createEmptyDatabase(target);
                    // MIGRATION SAFETY: when BOTH a legacy file (e.g. bf_memory_db_identity.json)
                    // and the new-named file (bf_memory_db_people.json) coexist on disk during the
                    // transition, both remap into the same bucket — dedupe by key so the merged
                    // bucket never carries a duplicate of the same fact. On a collision keep the
                    // NEWER copy by lastUpdated (was: first-file-wins, which silently kept the
                    // OLDER fact whenever the stale legacy file happened to load first — audit
                    // low-severity dedupe finding). Missing/invalid stamps coerce to 0, so a
                    // stamped copy always beats an unstamped one; equal stamps keep the incumbent.
                    const dupIdx = databases[target].facts.findIndex(f => f && f.key === fact.key);
                    if (dupIdx >= 0) {
                        const incumbent = databases[target].facts[dupIdx];
                        if ((Number(fact.lastUpdated) || 0) > (Number(incumbent.lastUpdated) || 0)) {
                            databases[target].facts[dupIdx] = fact; // replace in place (order preserved)
                        }
                        continue;
                    }
                    databases[target].facts.push(fact);
                    // Carry the earliest createdAt forward for the merged bucket.
                    if (Number(db.createdAt) && (!databases[target].createdAt || db.createdAt < databases[target].createdAt)) {
                        databases[target].createdAt = db.createdAt;
                    }
                }
                // Preserve an empty (factless) stored DB under its mapped name too.
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

/**
 * Get a single database by category name
 * @param {string} category
 * @returns {Promise<DatabaseSchema|null>}
 */
export async function getDatabase(category) {
    const all = await getAllDatabases();
    return all[category] || null;
}

/**
 * RANK-NOT-EVICT cold-tiering (replaces the old cap-based DELETION). When a category's ACTIVE
 * HOT non-sequence facts exceed HOT_SET_SIZE, mark the LOWEST-salience overflow `cold:true` in
 * place — NEVER deleting anything. Cold facts stay durable + queryable; they're just
 * deprioritized by retrieval/menu until re-mentioned/matched (which un-colds them).
 *
 * PROTECTED (never cold-tiered): sequence/track facts (ordered chains), superseded/inactive
 * history snapshots (already lowest priority, handled by isActiveFact), OPEN plot threads
 * (thread === 'open' — an unresolved hook must stay recallable until Reflection resolves it;
 * the protection lapses once thread flips to 'resolved'), and high-importance
 * facts (importance >= COLD_TIER_PROTECT_IMPORTANCE — foundational identity stays hot). Among
 * the remaining demotable facts we keep the HIGHEST-salience HOT_SET_SIZE hot and cold-tier the
 * rest, lowest salience first (importance + kind-modulated recency — same blend the old eviction
 * used). Idempotent: a fact already cold and still in the overflow stays cold (no re-log).
 *
 * Logs `fact.demoted` (level info, reason COLD_TIERED_LOW_SALIENCE) per newly-cold fact. NEVER
 * logs a deletion — there are none. Mutates db.facts entries in place; returns nothing.
 * @param {DatabaseSchema} db
 */
function coldTierOverflow(db) {
    if (!db || !Array.isArray(db.facts)) return;
    const now = Date.now();

    // Candidates that may be cold-tiered: ACTIVE, non-sequence, below the protect-importance
    // floor. Everything else is structurally protected and always counts as hot.
    const demotable = [];
    for (const f of db.facts) {
        if (!f || typeof f !== 'object') continue;
        if (!isActiveFact(f)) continue;                                  // history snapshots: not in the hot set
        if (isSequenceFact(f)) continue;                                 // ordered chains: never cold-tiered
        if (f.thread === 'open') continue;                               // unresolved plot threads: stay hot until resolved
        if (clampImportance(f.importance) >= COLD_TIER_PROTECT_IMPORTANCE) continue; // foundational: stay hot
        demotable.push(f);
    }

    // The hot working set is bounded by HOT_SET_SIZE across the demotable pool: keep the
    // highest-salience HOT_SET_SIZE hot, cold-tier the remainder (lowest salience first).
    if (demotable.length <= HOT_SET_SIZE) {
        // Under budget — nothing should be cold. Resurrect any fact that was previously cold
        // (e.g. the store shrank via supersession) so we don't strand stale cold flags.
        for (const f of demotable) {
            if (f.cold === true) uncoldFact(f, db.category, 'COLD_REACTIVATED', 'hot-set no longer over budget');
        }
        return;
    }

    // Sort descending by salience; the first HOT_SET_SIZE are hot, the tail is cold.
    const ranked = demotable.slice().sort((a, b) => salienceScore(b, now) - salienceScore(a, now));
    const keepHot = ranked.slice(0, HOT_SET_SIZE);
    const goCold = ranked.slice(HOT_SET_SIZE);

    // Anything that climbed back into the hot slice but was flagged cold gets resurrected.
    for (const f of keepHot) {
        if (f.cold === true) uncoldFact(f, db.category, 'COLD_REACTIVATED', 'rose back into hot set');
    }

    // Cold-tier the overflow tail. Only NEWLY-cold facts are flagged + logged (idempotent).
    for (const f of goCold) {
        if (f.cold === true) continue; // already cold; leave as-is (no re-log)
        f.cold = true;
        addDebugLog('info', `Fact cold-tiered (kept, deprioritized): [${db.category}] ${f.key} (score ${salienceScore(f, now).toFixed(2)}, imp ${clampImportance(f.importance)}, ${normalizeKind(f.kind)})`, {
            subsystem: 'db', event: 'fact.demoted', reason: 'COLD_TIERED_LOW_SALIENCE',
            data: {
                category: db.category, key: f.key,
                salienceScore: Number(salienceScore(f, now).toFixed(3)),
                hotSetSize: HOT_SET_SIZE,
            },
        });
    }
}

/**
 * Save a database (create or overwrite)
 * @param {DatabaseSchema} db
 */
export async function saveDatabase(db) {
    const avatar = getCharacterAvatar();
    if (!avatar) throw new Error('No character selected');

    // Per-turn cache: this is a WRITE — drop the memoized map so the next getAllDatabases()
    // re-reads fresh from disk (post-reply extraction writes here; a stale read afterward
    // would silently lose/duplicate facts). Invalidate BEFORE the async upload so even a
    // concurrent read mid-upload can't latch onto a now-stale snapshot.
    invalidateDatabaseCache();

    // redesign-v2 (S1): the user-level shared-memory strip/mirror was removed. Old facts that
    // still carry a stale `__sharedOrigin` tag are persisted as ordinary character facts.

    // INFINITE FACTS — RANK, NEVER EVICT. We do NOT delete facts when a category grows. Instead,
    // when the ACTIVE hot working set overflows HOT_SET_SIZE, the lowest-salience overflow is
    // COLD-TIERED (cold:true) — kept on disk (IDB + snapshot), still queryable, just deprioritized
    // by retrieval/menu until it's re-mentioned or directly matched (which un-colds it). This block
    // mutates the `cold` flag in place; NO fact is ever removed from db.facts.
    coldTierOverflow(db);

    // HYBRID WRITE. Prefer IDB as the fast working store; the durable attachment snapshot is
    // written on a throttled cadence (scheduleSnapshot) rather than on every fact write. On ANY
    // IDB failure (or when IDB is unavailable) fall through to the ORIGINAL synchronous
    // attachment upload so behavior is identical for users without usable IDB.
    if (idbAvailable()) {
        try {
            // ATOMIC read-modify-write (F-STOR-2): merge this one category into the avatar's full
            // IDB record INSIDE ONE readwrite transaction (idbUpdateRecord) so a single-category
            // save never drops the other categories AND a concurrent writer to the same avatar
            // can't interleave between our read and our write. The await resolves only after the
            // tx COMMITS — so the next getAllDatabases() (cache already invalidated above)
            // re-reads and sees this write (no stale-read-after-write).
            await idbUpdateRecord(avatar, (rec) => {
                const databases = (rec && rec.databases) ? rec.databases : {};
                databases[db.category] = db;
                // TOMBSTONE LIFECYCLE (F-STOR-4): writing facts into a category makes it LIVE
                // again — clear any delete-tombstone for it (a stale tombstone must not authorize
                // a future cross-device shrink of a re-created category). Other tombstones are
                // carried through unchanged so a save never erases delete markers.
                const tombs = { ...((rec && rec.deletedCategories) || {}) };
                delete tombs[db.category];
                return { databases, updatedAt: Date.now(), deletedCategories: tombs };
            });
            // Mark dirty + arm the throttled durable snapshot to attachments.
            scheduleSnapshot(avatar);
            return;
        } catch (e) {
            // IDB write failed mid-session → disable IDB and fall back to attachment-only for the
            // rest of the session so we never silently lose this write.
            console.error('[BFMemory] IDB save failed; falling back to attachment write', e);
            disableIdb('IDB save failed mid-session');
        }
    }

    // FALLBACK / attachment-only path (also the original behavior): upload synchronously.
    await saveDatabaseToAttachment(avatar, db);
}

/**
 * Write ONE category database to its attachment file (the ORIGINAL saveDatabase upload body,
 * unchanged in behavior). Used by (a) the attachment-only fallback in saveDatabase and (b) the
 * durable snapshot (snapshotAvatar). Caller has already enforced the fact cap. Throws on a failed
 * upload (callers decide how to handle: saveDatabase propagates; snapshotAvatar swallows).
 * @param {string} avatar
 * @param {DatabaseSchema} db
 */
async function saveDatabaseToAttachment(avatar, db) {
    const fileName = `${DB_PREFIX}${db.category.toLowerCase().replace(/[^a-z0-9]/g, '_')}.json`;
    const content = JSON.stringify(db, null, 2);
    const base64Data = btoa(unescape(encodeURIComponent(content)));

    const context = getContext();
    const extensionSettings = context.extensionSettings;

    // Ensure character attachments array exists
    if (!extensionSettings.character_attachments) {
        extensionSettings.character_attachments = {};
    }
    if (!extensionSettings.character_attachments[avatar]) {
        extensionSettings.character_attachments[avatar] = [];
    }

    const attachments = extensionSettings.character_attachments[avatar];

    // Upload the replacement FIRST; only remove the old file once the new one is safely
    // stored. Deleting before a failed upload permanently lost the category in
    // attachment-only mode (audit F-STOR-1).
    const { uploadFileAttachment } = await import('../../../../chats.js');
    const uniqueName = `${Date.now()}_${fileName}`;
    const fileUrl = await uploadFileAttachment(uniqueName, base64Data);
    if (!fileUrl) throw new Error('Upload failed');

    // Remove the superseded attachment with the same name (the new file is durable now)
    const existingIdx = attachments.findIndex(a => a.name === fileName);
    if (existingIdx >= 0) {
        try {
            await deleteAttachmentFile(attachments[existingIdx].url);
        } catch { /* ignore */ }
        attachments.splice(existingIdx, 1);
    }

    attachments.push({
        url: fileUrl,
        size: content.length,
        name: fileName,
        // DATA-SAFETY FIX (version stamp): stamp the file metadata `created` with the payload's
        // LOGICAL data version (`db.updatedAt`) rather than the upload-completion wall-clock, so
        // file metadata matches the data it carries. The version compare (attachmentSnapshotStamp)
        // reads the embedded `db.updatedAt` and only consults `created` for stampless legacy files,
        // but keeping them consistent prevents any path from resurrecting the old drift.
        created: Number(db?.updatedAt) || Date.now(),
    });

    // Save settings immediately (not debounced) to prevent data loss on page close
    if (context.saveSettingsDebounced) {
        context.saveSettingsDebounced();
        // Force flush if available
        if (typeof context.saveSettingsDebounced.flush === 'function') {
            context.saveSettingsDebounced.flush();
        }
    }
}

/**
 * Delete a database by category
 * @param {string} category
 */
export async function deleteDatabase(category) {
    const avatar = getCharacterAvatar();
    if (!avatar) return;

    // Per-turn cache: deleting a category is a write — invalidate so a later read re-fetches.
    invalidateDatabaseCache();

    // SNAPSHOT SAFETY (F4): cancel any throttled snapshot armed by an earlier fact write so its
    // timer can't fire after this delete and re-upload the category we're about to remove. (An
    // already-in-flight snapshot is reconciled by reconcileDeletedAttachments on its next pass /
    // the caller's flushSnapshotNow, which deletes files for categories no longer live in IDB.)
    cancelPendingSnapshot(avatar);

    // HYBRID: drop the category from the IDB working record first so the next read can't resurrect
    // it. Best-effort — on IDB failure we disable IDB and still remove the attachment below.
    // ATOMIC (F-STOR-2): the get + delete + put happen inside ONE readwrite transaction
    // (idbUpdateRecord), so a concurrent per-category save can no longer interleave between our
    // read and our write and have its category silently dropped by our stale put (or vice versa).
    if (idbAvailable()) {
        try {
            await idbUpdateRecord(avatar, (rec) => {
                // Preserved behavior: when the category isn't in the record, do NOT write at all
                // (no stamp bump, record untouched) — exactly like the old guarded put.
                if (!(rec && rec.databases && Object.prototype.hasOwnProperty.call(rec.databases, category))) {
                    return null;
                }
                delete rec.databases[category];
                // TOMBSTONE (F-STOR-4, multi-device deletes): record WHEN this category was
                // deliberately deleted. The tombstone rides the IDB record and is stamped into
                // every durable snapshot payload (snapshotAvatar), so ANOTHER device's rehydrate
                // guard can distinguish "deliberate delete" (adopt the smaller snapshot) from
                // "stale/partial snapshot" (refuse, keep local). Cleared when the category is
                // re-created by a later save (see saveDatabase).
                const tombs = { ...(rec.deletedCategories || {}) };
                tombs[category] = Date.now();
                return { databases: rec.databases, updatedAt: Date.now(), deletedCategories: tombs };
            });
        } catch (e) {
            console.error('[BFMemory] IDB delete failed; removing attachment only', e);
            disableIdb('IDB delete failed mid-session');
        }
    }

    // Always remove the durable attachment file too (the snapshot backup must lose it as well).
    const context = getContext();
    const attachments = context.extensionSettings?.character_attachments?.[avatar] || [];
    const fileName = `${DB_PREFIX}${category.toLowerCase().replace(/[^a-z0-9]/g, '_')}.json`;

    const idx = attachments.findIndex(a => a.name === fileName);
    if (idx >= 0) {
        try {
            await deleteAttachmentFile(attachments[idx].url);
        } catch { /* ignore */ }
        attachments.splice(idx, 1);
        context.saveSettingsDebounced?.();
    }
}

/**
 * Create a new empty database
 * @param {string} category
 * @returns {DatabaseSchema}
 */
export function createEmptyDatabase(category) {
    return {
        category,
        facts: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
}

// PROVENANCE (atomic #8). The generic `{ ...existing, ...fact }` spread on every update would
// clobber the GENESIS `source`/`validAt` with the most-recent message. These helpers preserve
// genesis attribution (source/validAt/learnedAt) and keep a compact capped trail of prior
// sources, so "where did it learn this?" stays answerable. Spread AFTER `...fact`.
const MAX_SOURCE_HISTORY = 10;

function initProvenance(fact, now) {
    return { learnedAt: now };
}

function mergeProvenance(existing, incoming, now) {
    const genesisSource = existing.source || incoming.source || '';
    const genesisValidAt = (existing.validAt !== undefined) ? existing.validAt : incoming.validAt;
    const learnedAt = existing.learnedAt || existing.lastUpdated || now;
    let history = Array.isArray(existing.sourceHistory) ? [...existing.sourceHistory] : [];
    const prevSource = existing.source;
    if (prevSource && incoming.source && prevSource !== incoming.source) {
        history.push({ src: prevSource, at: existing.lastUpdated || now });
        if (history.length > MAX_SOURCE_HISTORY) history.splice(0, history.length - MAX_SOURCE_HISTORY);
    }
    // Bi-temporal (feature): story-world `validFrom` is a GENESIS stamp (when the fact became true
    // in-story) — keep first-wins like `validAt` so a re-mention can't move the established start.
    // `validUntil` (when it stopped being true) is intentionally NOT pinned here: it can legitimately
    // be set/updated later (e.g. a fact later marked as ended), so it flows through from `...fact`.
    // Both are only present when the bi-temporal feature wrote them, so this is a no-op otherwise.
    const genesisValidFrom = (existing.validFrom !== undefined) ? existing.validFrom : incoming.validFrom;
    return {
        source: genesisSource,
        validAt: genesisValidAt,
        learnedAt,
        ...(genesisValidFrom !== undefined ? { validFrom: genesisValidFrom } : {}),
        ...(history.length ? { sourceHistory: history } : {}),
    };
}

/**
 * ISO 8601 UTC cutoff string for "N days ago" (atomic #14). ISO strings of equal length sort
 * lexicographically, so `fact.createdAt < sinceIso(days)` is a valid recency filter with no
 * date parsing. days<=0 yields "now".
 * @param {number} days
 * @returns {string}
 */
export function sinceIso(days) {
    return new Date(Date.now() - Math.max(0, days) * 86400000).toISOString();
}

/**
 * Add or update a fact in a database
 * @param {DatabaseSchema} db
 * @param {FactSchema} fact
 * @returns {DatabaseSchema} Updated database
 */
export function upsertFact(db, fact) {
    // `supersedes` is a TRANSIENT write-time signal (temporal-validity feature), consumed
    // by shouldSupersede() below — it must NEVER be persisted onto a stored fact. Read it
    // off a local copy so the spreads (`...fact`) below can't leak it onto db.facts.
    const supersedesSignal = fact && fact.supersedes === true;
    if (fact && 'supersedes' in fact) { fact = { ...fact }; delete fact.supersedes; }

    // SEQUENCE FACTS (Feature #4): a fact carrying a `track` is one ordered step in a
    // timeline (e.g. `<char>_location_3`). Each step is its OWN fact — they must NEVER
    // be collapsed by the reconcile-on-write normalize-merge below (which would make
    // `_2` and `_3` overwrite each other and destroy the chain — the known bug). We
    // therefore (a) skip the normalized variant match entirely for track facts and (b)
    // auto-assign a monotonic `ord` from the existing steps in that track at write time,
    // so the LLM never has to track step numbers reliably.
    if (isSequenceFact(fact)) {
        // Auto-assign ord if missing/invalid: max existing ord in this track + 1.
        let ord = Number(fact.ord);
        if (!Number.isInteger(ord) || ord <= 0) {
            ord = nextOrdForTrack(db, fact.track);
        }
        const seqFact = { ...fact, ord };
        // Match an existing step ONLY by exact (track + ord) identity — re-running the
        // same extraction shouldn't duplicate a step, but distinct ords stay distinct.
        const exactStepIdx = db.facts.findIndex(f =>
            isSequenceFact(f) && f.track === seqFact.track && Number(f.ord) === ord);
        // Also honor an exact KEY match (idempotent re-write of the same step key).
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
            db.facts.push({ ...seqFact, ...normalizeSalienceFields(seqFact), ...initProvenance(seqFact, Date.now()), createdAt: new Date().toISOString(), lastUpdated: Date.now() });
            addDebugLog('debug', `Sequence step added: [${db.category}] ${seqFact.key} (track ${seqFact.track}, ord ${ord})`, {
                subsystem: 'db', event: 'fact.created',
                data: { category: db.category, key: seqFact.key, value: seqFact.value, subject: deriveSubject(seqFact), aspect: deriveAspect(seqFact), track: seqFact.track, ord, isSequence: true },
            });
        }
        db.updatedAt = Date.now();
        return db;
    }

    // 1) Exact key match — always update in place.
    let existingIdx = db.facts.findIndex(f => f.key === fact.key);
    // 2) Reconcile-on-write (FIX #2c): if no exact match, look for a fact whose key
    //    is a CLEAR variant of the incoming key (e.g. `demeanor` vs `demeanor_1`,
    //    `hair_color` vs `haircolor`, `trait` vs `traits`). Without this, Agent 3
    //    mints parallel keys and contradictory facts coexist (a "gentle" trait
    //    lingering alongside a later "rough" one). We only merge clear normalized
    //    matches — distinct properties (different normalized keys) stay separate.
    //    Sequence steps are handled above and never reach this path.
    let matchVia = existingIdx >= 0 ? 'EXACT_KEY' : null;
    if (existingIdx < 0) {
        const normIncoming = normalizeFactKey(fact.key);
        if (normIncoming) {
            // Never collapse a non-sequence write onto a sequence step (or vice versa).
            existingIdx = db.facts.findIndex(f => !isSequenceFact(f) && normalizeFactKey(f.key) === normIncoming);
            if (existingIdx >= 0) matchVia = 'NORMALIZED_KEY';
        }
    }
    // 2b) PAIR-KEY CANONICALIZER (relationship-status follow-up): the per-pair relationship
    //    STATUS record's key is EXACTLY `<a>_<b>_status` (two distinct single name tokens +
    //    the literal suffix — the same strict shape the Scribe prompt and the reflection
    //    maintenance route validate). If a writer ever emits the REVERSED orientation
    //    (`<b>_<a>_status`), neither the normalized match above (token order differs) nor the
    //    parallel-state match below (subjects differ) catches it, so a duplicate contradictory
    //    pair record would be minted. Deterministically adopt the STORED orientation instead:
    //    key, subject, and partner all flip so the merged fact stays coherent
    //    (subj:<a> + involved:[<b>] matches key `<a>_<b>_status`), and the write then rides
    //    the normal update/supersession path below like any re-mention of the canonical key.
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
    // 3) STRONGER PARALLEL-KEY DEDUP (feature #5): if STILL no match and the incoming
    //    write is a changeable `state`, look for an existing CURRENT state fact with the
    //    SAME subject + SAME leading facet/aspect under a parallel key (the real-data bug:
    //    four live `<name>_clothing*` facts for one evolving thing). Only the incoming
    //    `state` kind is considered — untyped/trait/event writes never trigger this, to
    //    stay conservative. The match is then routed through the existing supersession
    //    path below (which snapshots the old value as history), so a parallel near-dup
    //    updates the canonical fact instead of coexisting. We pin the canonical key to the
    //    matched fact's key so subsequent writes converge on it.
    if (existingIdx < 0 && normalizeKind(fact.kind) === 'state'
        && fact.kind !== undefined && fact.kind !== null && String(fact.kind).trim()) {
        const parallelIdx = findParallelStateKey(db, fact, -1);
        if (parallelIdx >= 0) {
            existingIdx = parallelIdx;
            matchVia = 'PARALLEL_KEY';
            // Adopt the existing canonical key so the merge updates-in-place / supersedes
            // rather than renaming (mirrors the in-place-correction policy below).
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
        // RESURRECTION: re-mentioning/updating a fact is relevance — pull it back into the hot
        // working set (un-cold) if it had been cold-tiered. Cleared on `existing` so the spreads
        // below can't carry a stale `cold:true` onto the advanced/updated fact. (A no-op
        // re-mention of an already-hot fact does nothing; uncoldFact only logs on a real change.)
        uncoldFact(existing, db.category, 'COLD_REACTIVATED', 'updated/re-mentioned');
        // Merge relationships (union) rather than replace, so prior tier links survive.
        const mergedRels = mergeRelationships(existing.relationships, fact.relationships);
        // Preserve context across merges: a new write keeps the old context note unless
        // it provides its own (Feature #3) — so re-mentioning a fact without context
        // doesn't wipe a previously-attached note.
        const mergedContext = mergeContext(existing.context, fact.context);
        // Layer A: union aliases (dedupe) so re-mentions accumulate nicknames/descriptors
        // rather than overwrite. Match-only — never shown to the writer.
        const mergedAliases = mergeAliases(existing.aliases, fact.aliases);
        // Involved feature: union participants so a bare re-mention can't wipe a prior list.
        const mergedInvolved = mergeInvolved(existing.involved, fact.involved);
        // Merge salience: keep the HIGHER importance (a fact only grows more foundational
        // as it's re-mentioned, never wiped by a bare re-mention); prefer the incoming
        // kind if the writer provided one, else keep existing.
        const sal = mergeSalience(existing, fact);

        // TEMPORAL SUPERSESSION (Phase 3): when a CHANGEABLE-STATE fact's value genuinely
        // changes (or Agent 3 explicitly signals it), keep history truthful by snapshotting
        // the OLD value as a retained-but-inactive copy, then advancing the canonical fact
        // in place to the new ACTIVE value. Durable traits (and no-op re-mentions) keep the
        // existing silent in-place correction below. We retain only the SINGLE most-recent
        // superseded snapshot per logical key (older inactive snapshots for the same
        // normalized key are dropped) so this never blows the fact cap — deeper history is
        // the job of the track/diary feature, not this lightweight breadcrumb.
        if (existing.active !== false && shouldSupersede(existing, fact, supersedesSignal)) {
            const now = Date.now();
            const oldSupersededValue = existing.value;
            const snapshotKey = makeSupersededKey(db, existing.key);
            // Build the inactive history snapshot from the OLD fact's state.
            const snapshot = {
                ...existing,
                key: snapshotKey,
                active: false,
                supersededAt: now,
                supersededBy: existing.key, // in-place: canonical key is unchanged
            };
            // redesign-v2 (S1): the opt-in bi-temporal validUntil stamping was removed
            // (existing validFrom/validUntil fields on old facts are carried through untouched).
            // Drop any prior superseded snapshot of this same logical key (keep just one).
            const normCanon = normalizeFactKey(existing.key);
            db.facts = db.facts.filter(f =>
                !(f.active === false && f !== existing && normalizeFactKey(stripSupersededSuffix(f.key)) === normCanon));
            // Re-find the canonical fact (filter may have shifted indices).
            const canonIdx = db.facts.findIndex(f => f.key === existing.key);
            db.facts.push(snapshot);
            // Advance the canonical fact to the new active value, clearing any stale
            // supersession markers (it's the current truth again).
            // SCENE STRAND EXCEPTION (Spiderweb 2): first-wins normally pins a fact to its origin
            // scene, but a SUPERSESSION is a genuinely-new establishment of the live value — so the
            // live fact carries the NEW (incoming) scene while the `__was` snapshot above keeps the
            // OLD origin scene. mergeSalience returned the old scene (first-wins); override it here
            // with the incoming when present so the live fact advances. Source provenance likewise
            // points at the message that established the new value.
            const liveSceneOverride = {};
            if (Number.isInteger(fact?.sceneNo)) {
                liveSceneOverride.sceneNo = fact.sceneNo;
                if (fact.sceneName) liveSceneOverride.sceneName = fact.sceneName;
            }
            if (typeof fact?.sourceMsg === 'string' && fact.sourceMsg) liveSceneOverride.sourceMsg = fact.sourceMsg;
            db.facts[canonIdx] = {
                ...existing, ...fact, key: existing.key, relationships: mergedRels,
                context: mergedContext, aliases: mergedAliases, involved: mergedInvolved, ...sal, ...liveSceneOverride, active: true,
                ...mergeProvenance(existing, fact, now),
                createdAt: existing.createdAt || new Date(now).toISOString(),
                supersededAt: undefined, supersededBy: undefined, lastUpdated: now,
            };
            db.updatedAt = now;
            addDebugLog('info', `Fact superseded: [${db.category}] ${existing.key} (old kept as ${snapshotKey})`, {
                subsystem: 'db', event: 'fact.superseded',
                reason: supersedesSignal ? 'EXPLICIT_SUPERSEDE_MARKER' : 'STATE_CHANGED_HEURISTIC',
                data: { category: db.category, key: existing.key, snapshotKey, subject: deriveSubject(existing), aspect: deriveAspect(existing) },
                before: oldSupersededValue, after: fact.value,
            });
            return db;
        }

        // Keep the existing canonical key so we update in place instead of renaming
        // (renaming would orphan any relationship refs pointing at the old key).
        const oldValue = existing.value;
        const updNow = Date.now();
        db.facts[existingIdx] = { ...existing, ...fact, key: existing.key, relationships: mergedRels, context: mergedContext, aliases: mergedAliases, involved: mergedInvolved, ...sal, ...mergeProvenance(existing, fact, updNow), createdAt: existing.createdAt || new Date(updNow).toISOString(), lastUpdated: updNow };
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
        db.facts.push({ ...fact, ...normalizeSalienceFields(fact), ...initProvenance(fact, Date.now()), createdAt: new Date().toISOString(), lastUpdated: Date.now() });
        addDebugLog('info', `Fact created: [${db.category}] ${fact.key}`, {
            subsystem: 'db', event: 'fact.created',
            data: { category: db.category, key: fact.key, value: fact.value, subject: deriveSubject(fact), aspect: deriveAspect(fact) },
        });
    }
    db.updatedAt = Date.now();
    return db;
}

// Suffix appended to a superseded snapshot's key so it (a) stays a distinct fact and
// (b) normalizes differently from the live canonical key (so reconcile-on-write never
// collapses a new write onto a history snapshot).
const SUPERSEDED_SUFFIX = '__was';

/**
 * Mint a unique key for an inactive history snapshot of `canonicalKey`. Numeric tail keeps
 * snapshots distinct if more than one ever coexists transiently.
 * @param {DatabaseSchema} db
 * @param {string} canonicalKey
 * @returns {string}
 */
function makeSupersededKey(db, canonicalKey) {
    const base = `${canonicalKey}${SUPERSEDED_SUFFIX}`;
    let n = 1;
    let key = `${base}${n}`;
    const taken = new Set((db.facts || []).map(f => f.key));
    while (taken.has(key)) { n++; key = `${base}${n}`; }
    return key;
}

/** Strip the superseded-snapshot suffix (and its numeric tail) back to the canonical key. */
function stripSupersededSuffix(key) {
    return String(key || '').replace(new RegExp(`${SUPERSEDED_SUFFIX}\\d*$`), '');
}

// =============================================================================
// CROSS-KEY SUPERSEDE RULES (community adoption Tier 1; NarrativeEngine timeline
// prior art — report §1.6). The per-key supersession above only fires when the SAME
// logical key is re-written; but some story events invalidate OTHER keys: a character
// who dies no longer has a meaningful `current_location`, a destroyed heirloom has no
// `ownership`. These rules are a small DETERMINISTIC table (no LLM): when a genuinely
// NEW death/departure/loss fact lands, same-subject changeable-STATE facts under the
// rule's target aspects are retired to `__was` history — the SAME snapshot-not-delete
// provenance as per-key supersession, never a deletion. Applied at the genuine-new-write
// CALLERS (Scribe applyUpdates, Writer remember_fact, review-popup edits), NOT inside
// upsertFact, so migrations/rebuilds/merges that replay old facts can never re-fire them.
// Gated by `crossKeySupersede` (default ON — free + deterministic; OFF restores
// per-key-only behavior byte-for-byte).
// =============================================================================

// Deterministic rule table. A fact TRIGGERS a rule when its aspect is in `trigger.aspects`
// (event-shaped keys like `death_event`), OR its aspect is in `trigger.valueAspects` AND it
// is an explicit kind:'state' AND its value matches `trigger.valueRx` (state-shaped writes
// like `status = "dead"`). Matching rule => same-subject active state facts whose aspect is
// in `targetAspects` are retired. Departure deliberately has NO value regex — "left"/"gone"
// prose is far too ambiguous; only the explicit event aspects fire it.
const CROSS_KEY_RULES = [
    {
        id: 'death',
        trigger: {
            aspects: new Set(['death', 'death_event']),
            valueAspects: new Set(['status', 'health']),
            // Negation lookbehind keeps "almost died" / "not dead" / "nearly killed" from firing.
            valueRx: /(?<!\b(?:almost|nearly|not)\s)\b(dead|died|dies|killed|deceased|slain|perished|passed away)\b/i,
        },
        // Alive-status + presence: where they are, what they're doing, who they're with (§1.6).
        targetAspects: new Set(['current_location', 'current_activity', 'current_goal', 'companions_present', 'status', 'health']),
    },
    {
        id: 'departure',
        trigger: {
            aspects: new Set(['departure', 'departure_event', 'relocation']),
            valueAspects: new Set(),
            valueRx: null,
        },
        // Presence only — a departed character keeps goals/health, just isn't HERE anymore.
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

// Blast-radius bound: one trigger may retire at most this many facts across ALL categories,
// so a subject-collision misfire (see deriveSubject's key-prefix heuristic) stays contained.
const MAX_CROSS_KEY_INVALIDATIONS = 8;

/**
 * Resolve a fact's aspect against its OWNING category's vocab. Stored facts usually do NOT
 * carry a `category` field (only the owning db does), and deriveAspect(fact) alone would then
 * validate against the Unsorted fallback vocab — collapsing e.g. `current_location` to `misc`
 * and silently neutering the rule match. Prefer the fact's own field when present (migrated
 * facts), else the owning db/category name.
 * @param {FactSchema} fact
 * @param {string} owningCategory - the category of the db the fact lives in (or is bound for)
 * @returns {string}
 */
function aspectInCategory(fact, owningCategory) {
    return normalizeAspect(fact?.aspect, fact?.category || owningCategory);
}

/**
 * Apply the cross-key supersede rules for ONE genuinely-new fact write (feature:
 * crossKeySupersede, default ON). Pure code, no LLM. When `fact` (just written into
 * `category`) matches a rule, every ACTIVE non-sequence kind:'state' fact in ANY category
 * with the SAME derived subject and a TARGET aspect is retired to `__was` history
 * (invalidateFactCrossKey), up to MAX_CROSS_KEY_INVALIDATIONS. Callers must persist the
 * returned categories (the maps are mutated in place, exactly like upsertFact).
 *
 * CALLER CONTRACT: call this ONLY on genuine new-information writes (Scribe commit, Writer
 * remember_fact, review-popup edit) — never from migration/rebuild/merge replays.
 * @param {Object<string, DatabaseSchema>} databases - the live category -> db map (mutated)
 * @param {FactSchema} fact - the just-written trigger fact
 * @param {string} category - the category `fact` was written into
 * @returns {string[]} names of categories whose facts were modified (need saving)
 */
export function applyCrossKeySupersedeRules(databases, fact, category) {
    // Setting gate: default ON when absent; explicit false restores per-key-only behavior.
    try {
        if (host.getExtensionSettings()?.crossKeySupersede === false) return [];
    } catch { /* settings unavailable — default ON */ }
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

    const triggerRef = `${category}/${fact.key}`; // Category/key cross-ref (see FactSchema supersededBy)
    const normTrigger = normalizeFactKey(fact.key);
    const now = Date.now();
    const touched = [];
    let invalidated = 0;

    for (const [cat, db] of Object.entries(databases || {})) {
        if (invalidated >= MAX_CROSS_KEY_INVALIDATIONS) break;
        if (!db || !Array.isArray(db.facts)) continue;
        // Snapshot the candidate set FIRST — invalidateFactCrossKey reassigns db.facts (it
        // drops older __was snapshots), so we never iterate the live array while mutating it.
        // Targets must be: currently valid, not an append-only track step, an explicit
        // changeable STATE (legacy kind-less facts default to 'trait' and are never swept),
        // the SAME subject, a target aspect, not the trigger itself (self-guard), and not
        // already saying the same thing as the trigger.
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

/**
 * Retire ONE fact to `__was` history because a cross-key rule fired (crossKeySupersede).
 * Mirrors upsertFact's supersession branch MINUS the "advance the canonical fact" half —
 * there is no incoming value for this key, the truth simply ENDED. The fact is renamed in
 * place to a superseded snapshot key (so a later legitimate write to the canonical key
 * creates a fresh ACTIVE fact instead of silently carrying `active:false` forward through
 * the merge spread), stamped inactive with provenance, and any OLDER `__was` snapshot of
 * the same logical key is dropped (keep just one — same policy as per-key supersession).
 * Normal supersession provenance — NEVER a deletion.
 * @param {DatabaseSchema} db - owning database (mutated)
 * @param {FactSchema} target - the ACTIVE fact object to retire (mutated in place)
 * @param {string} triggerRef - `Category/key` of the triggering fact (stored in supersededBy)
 * @param {string} ruleId - which CROSS_KEY_RULES entry fired (for the debug log)
 * @param {number} now - shared ms timestamp for the batch
 * @returns {void}
 */
function invalidateFactCrossKey(db, target, triggerRef, ruleId, now) {
    const canonicalKey = target.key;
    const oldValue = target.value;
    const snapshotKey = makeSupersededKey(db, canonicalKey);
    target.key = snapshotKey;
    target.active = false;
    target.supersededAt = now;
    target.supersededBy = triggerRef; // Category/key cross-ref form (no readers depend on bare keys)
    // redesign-v2 (S1): bi-temporal validUntil stamping removed (old fields tolerated on load).
    // Drop any prior superseded snapshot of this same logical key (keep just one).
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

/**
 * Derive the SUBJECT axis of a fact (the who/what it is about) — feature: subject axis.
 * Prefers an explicit `subject` field (emitted by Agent 3 via the `subj:` marker); falls
 * back deterministically to the token before the first underscore in the key
 * (`<NAME>_<PLACE>_<OBJECT>` -> `<NAME>`). Returns '' when neither is derivable. Lowercased,
 * trimmed. Back-compat: facts with no `subject` field still resolve via the key prefix.
 *
 * PLACE-FILING FIX (scope feature): for a `scope:place` fact the SUBJECT must be the PLACE,
 * not the owning character — otherwise a key like `<NAME>_<PLACE>` files the location under
 * the character and it can't be recalled when the owner is absent. So when a fact resolves to
 * scope `place` we PREFER its explicit `subject` (the place, which Agent 3 supplies via
 * `subj:`); only if no explicit subject was given do we fall back to the SECOND key token
 * (`<NAME>_<PLACE>...` -> `<PLACE>`), and finally the first token. Character-scope derivation
 * is unchanged (first token / explicit subject), so existing facts are unaffected.
 * @param {FactSchema} fact
 * @returns {string}
 */
export function deriveSubject(fact) {
    if (!fact) return '';
    // Defensive `@`-strip (composes with the parser-side strip in agent-memory.js): a stored
    // subject must NEVER carry the Scribe's `@<name>` sigil — a leading `@` would break the
    // `key.startsWith(subject + '_')` facet/dedup check, the bySubject index, and the focus
    // filter. Strip it on read so any legacy `@`-polluted fact self-heals (lowercased/trimmed
    // consistently with how subjects are normalized elsewhere).
    const explicit = String(fact.subject || '').trim().toLowerCase().replace(/^@/, '').trim();
    if (explicit) return resolveGenericSubjectToken(explicit);
    const key = String(fact.key || '').trim().toLowerCase();
    if (!key) return '';
    // Place facts: the location owns the fact, not the prefix character. With no explicit
    // subject, take the token AFTER the first underscore (the place token) when present.
    if (normalizeScope(fact.scope) === 'place') {
        const tokens = key.split('_').filter(Boolean);
        if (tokens.length >= 2) return tokens[1];
        return tokens[0] || '';
    }
    const us = key.indexOf('_');
    const prefix = us > 0 ? key.slice(0, us) : key;
    return resolveGenericSubjectToken(prefix);
}

// Reserved generic placeholders the Scribe emits for "the character" / "the user". When a stored
// fact's subject (explicit or key-derived) is one of these, it is NOT a real subject — resolving
// it to the active character/user name keeps the focus filter, bySubject index, and parallel-state
// matcher from collapsing distinct characters under one literal "char"/"user" bucket. This is the
// DEFENSIVE half of the HUB FIX (the primary resolution happens on the Scribe's parsed output in
// agent-memory.js); it also repairs LEGACY `char_*`/`user_*` facts already on disk.
const _RESERVED_CHAR_SUBJECT = new Set(['char', '{{char}}', 'character']);
const _RESERVED_USER_SUBJECT = new Set(['user', '{{user}}', 'persona']);

/**
 * Resolve a reserved generic subject token (`char`/`user`/`{{char}}`/`{{user}}`) to the active
 * character / user-persona name (lowercased, key-safe). A real proper-name subject is returned
 * unchanged. Never returns the bare literal "char"/"user" when a real name is resolvable — so no
 * stored fact reads its subject as a generic placeholder downstream. Falls back to the literal
 * token only when no real name is available (unnamed character), which is still safer than before
 * because the parser-side resolution already prevents this for new writes.
 * @param {string} token - a lowercased subject token
 * @returns {string}
 */
function resolveGenericSubjectToken(token) {
    // Defensive `@`-strip: an incoming token may still carry the Scribe's `@<name>` sigil (e.g.
    // `@char`/`@{{char}}`). Strip it so the reserved-token lookup below matches the bare form
    // (`@char` → `char`) and no `@`-prefixed literal is ever returned as a subject.
    const t = String(token || '').trim().toLowerCase().replace(/^@/, '').trim();
    if (!t) return '';
    let real = '';
    try {
        if (_RESERVED_CHAR_SUBJECT.has(t)) real = String(host.getCurrentCharacterName() || '').trim();
        else if (_RESERVED_USER_SUBJECT.has(t)) real = String(host.getUserPersonaName() || '').trim();
    } catch { /* host unavailable — fall through to the literal token */ }
    return real ? real.toLowerCase() : t;
}

/**
 * Derive the FACET/aspect of a fact: the key with its subject prefix removed and the
 * trailing qualifier token (the last `_segment`) dropped, normalized. This groups
 * temporal-state variants of ONE evolving thing
 * (`<name>_clothing`, `<name>_clothing_change`, `<name>_clothing_current`) onto one aspect
 * (`clothing`) so STRONGER-DEDUP can supersede instead of minting parallel keys, while
 * keeping genuinely distinct sub-properties (`x_womens_clothing_stock` vs `..._reason`)
 * apart only when they share NO leading facet token. Used together with a strict gate in
 * upsertFact (state-only, same-subject, shared leading facet token) so the match stays
 * conservative. Returns '' when the key is just the subject (no facet).
 * @param {FactSchema} fact
 * @returns {string}
 */
// ALLOWLIST of trailing tokens that are pure VERSION/TENSE qualifiers — a "variant of the same
// thing", safe to collapse onto the base facet (`clothing_current`/`clothing_change` → `clothing`).
// We ONLY ever drop a trailing token when it is one of these. The previous blanket "drop the last
// token whenever there's >1" rule discarded the DISTINGUISHING token of compound facets
// (`physical_location` vs `physical_state`, `interaction` vs `interaction_style`), causing a
// location to clobber a physical state. Keeping the full facet otherwise preserves those as
// distinct slots while still merging genuine temporal variants.
const FACET_VERSION_QUALIFIERS = new Set([
    'current', 'latest', 'now', 'change', 'changed', 'update', 'updated', 'new', 'state', 'status', 'prev', 'previous',
]);

/**
 * Strip a leading subject prefix from a key and return the remaining facet tokens (lowercased,
 * separator-split, empties removed). Returns null when the key is just the subject (no facet).
 * @param {FactSchema} fact
 * @returns {string[]|null}
 */
function facetTokensOf(fact) {
    const key = String(fact?.key || '').trim().toLowerCase();
    if (!key) return null;
    const subject = deriveSubject(fact);
    let rest = key;
    if (subject && key === subject) return null; // key is just the subject — no facet
    if (subject && key.startsWith(subject + '_')) rest = key.slice(subject.length + 1);
    const tokens = rest.split('_').filter(Boolean);
    return tokens.length ? tokens : null;
}

function factAspect(fact) {
    const tokens = facetTokensOf(fact);
    if (!tokens) return '';
    // Drop the trailing token ONLY when it is a recognized version/tense qualifier, so
    // `clothing_current`/`clothing_change` collapse to `clothing` but the DISTINGUISHING trailing
    // token of a compound facet is KEPT (`physical_location` ≠ `physical_state`,
    // `interaction` ≠ `interaction_style`). A single-token facet is always preserved as-is.
    const last = tokens[tokens.length - 1];
    const facetTokens = (tokens.length > 1 && FACET_VERSION_QUALIFIERS.has(last)) ? tokens.slice(0, -1) : tokens;
    return facetTokens.join('');
}

/**
 * Leading facet token of a fact (first token after the subject prefix). Used as the
 * conservative shared-aspect gate for STRONGER-DEDUP — two state facts must agree on
 * this token (and subject) before parallel-key reconciliation is even considered.
 * @param {FactSchema} fact
 * @returns {string}
 */
function leadingFacetToken(fact) {
    const tokens = facetTokensOf(fact);
    return tokens ? (tokens[0] || '') : '';
}

/**
 * STRONGER-DEDUP (feature #5): find an existing NON-sequence STATE fact that the incoming
 * write should supersede because it describes the SAME subject + SAME evolving aspect
 * under a parallel key (e.g. incoming `<name>_clothing_current` vs stored `<name>_clothing`).
 * Conservative gate — ALL must hold:
 *   - both incoming and candidate resolve to a non-empty, EQUAL subject,
 *   - both share the same leading facet token (so `clothing*` only merges with `clothing*`),
 *   - both resolve to the SAME full aspect (`physical_location` ≠ `physical_state` — the
 *     allowlist-aware factAspect keeps the distinguishing token),
 *   - NEITHER key carries a trailing `_<int>` enumeration suffix (`_1`/`_2`/`_3` are the Scribe's
 *     DISTINCTNESS signal for separate co-existing items — never collapse them),
 *   - the candidate is a CURRENT `state` fact (durable traits/events are never collapsed),
 *   - the incoming write is itself a state (or untyped — see caller; untyped is excluded),
 *   - neither is a sequence/track fact (handled separately, append-only),
 *   - the candidate is not the exact-key match already found.
 * Returns the matched index or -1. Reuses the supersession path so the old value is kept
 * as inactive history rather than silently overwritten. Genuine SAME-slot state evolution (same
 * key, e.g. standing→sitting) still supersedes via the exact-key path; this only catches
 * parallel-key near-dups of the SAME aspect.
 * @param {DatabaseSchema} db
 * @param {FactSchema} incoming
 * @param {number} excludeIdx - index already matched by exact/normalized key (skip it)
 * @returns {number}
 */
function findParallelStateKey(db, incoming, excludeIdx) {
    if (!db || !Array.isArray(db.facts)) return -1;
    if (isSequenceFact(incoming)) return -1;
    // Numbered enumeration keys (`..._1`, `..._2`) are DISTINCT items by the Scribe's own idiom —
    // never parallel-collapse them onto a same-aspect neighbor.
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
        if (f.active === false) continue;            // never reconcile onto history snapshots
        if (hasNumericTail(f.key)) continue;         // distinct enumerated item — keep separate
        if (normalizeKind(f.kind) !== 'state') continue; // only changeable state collapses
        if (deriveSubject(f) !== incSubject) continue;
        if (leadingFacetToken(f) !== incLead) continue;
        if (factAspect(f) !== incAspect) continue;
        return i;
    }
    return -1;
}

/**
 * True when a key ends in a `_<int>` enumeration suffix (`char_clothing_condition_2`). Such a
 * suffix is the Scribe's explicit DISTINCTNESS signal for separate co-existing items, so these
 * keys are excluded from the parallel-state collapse (they must NOT supersede each other).
 * @param {string} key
 * @returns {boolean}
 */
function hasNumericTail(key) {
    return /_\d+$/.test(String(key || '').trim().toLowerCase());
}

/**
 * True if a fact is a sequence/event step — i.e. it carries a non-empty `track`
 * (Feature #4). Such facts form an ordered chain and are EXEMPT from reconcile-on-write
 * collapse and from key-normalized merging.
 * @param {FactSchema} fact
 * @returns {boolean}
 */
export function isSequenceFact(fact) {
    return !!(fact && typeof fact.track === 'string' && fact.track.trim());
}

/**
 * Compute the next monotonic ord for a track: (max existing ord in that track) + 1,
 * starting at 1 for a brand-new track. Called at write time so the LLM doesn't have
 * to number steps itself.
 * @param {DatabaseSchema} db
 * @param {string} track
 * @returns {number}
 */
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

/**
 * Stamp normalized importance/kind onto a fresh (NEW) fact. Only writes the fields when
 * the incoming fact actually provided them, so a fact written without them stays lean
 * and falls back to DEFAULT_IMPORTANCE/DEFAULT_KIND at read time (back-compat).
 * @param {FactSchema} fact
 * @returns {{importance?: number, kind?: string}}
 */
function normalizeSalienceFields(fact) {
    const out = {};
    if (fact && fact.importance !== undefined && fact.importance !== null) {
        out.importance = clampImportance(fact.importance);
    }
    if (fact && fact.kind !== undefined && fact.kind !== null && String(fact.kind).trim()) {
        out.kind = normalizeKind(fact.kind);
    }
    // USE-IT-OR-LOSE-IT: stamp use-tracking fields with safe defaults so every fact carries
    // them from creation (the strengthening machinery in both salience fns assumes presence).
    // Preserve any incoming non-zero values (e.g. a fact rehydrated/imported with prior usage).
    out.useCount = Math.max(0, Math.floor(Number(fact?.useCount) || 0));
    out.lastUsedAt = Math.max(0, Math.floor(Number(fact?.lastUsedAt) || 0));
    // Episodic-memory feature: clamp the optional `tone` on creation (only when provided, so a
    // fact without one stays lean — mirrors how `location` is only attached when present).
    const tone = normalizeTone(fact?.tone);
    if (tone) out.tone = tone;
    // SCENE + SOURCE STRANDS (Spiderweb 2): stamp the origin scene + source-message handle on a
    // fresh fact when provided (only-when-present, mirrors `tone`). Coerced defensively.
    if (Number.isInteger(fact?.sceneNo) && fact.sceneNo >= 1) {
        out.sceneNo = fact.sceneNo;
        if (typeof fact?.sceneName === 'string' && fact.sceneName.trim()) out.sceneName = fact.sceneName.trim();
    }
    if (typeof fact?.sourceMsg === 'string' && fact.sourceMsg.trim()) out.sourceMsg = fact.sourceMsg.trim();
    return out;
}

/**
 * Merge salience (importance/kind) on a fact update. Keep the HIGHER importance so a
 * fact never loses foundational weight from a bare re-mention; prefer the incoming kind
 * when provided, else keep the existing. Returns only the fields that should be set so
 * a spread can't clobber an existing value with undefined.
 * @param {FactSchema} existing
 * @param {FactSchema} incoming
 * @returns {{importance?: number, kind?: string}}
 */
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
    // USE-IT-OR-LOSE-IT: a merge must PRESERVE accumulated strengthening — keep the HIGHER of
    // each so a bare re-mention (which carries no usage) never resets a fact's earned salience.
    const exUse = Math.max(0, Math.floor(Number(existing?.useCount) || 0));
    const incUse = Math.max(0, Math.floor(Number(incoming?.useCount) || 0));
    out.useCount = Math.max(exUse, incUse);
    const exUsedAt = Math.max(0, Math.floor(Number(existing?.lastUsedAt) || 0));
    const incUsedAt = Math.max(0, Math.floor(Number(incoming?.lastUsedAt) || 0));
    out.lastUsedAt = Math.max(exUsedAt, incUsedAt);
    // Episodic-memory feature: carry the optional `tone` forward — PREFER the incoming (clamped)
    // when a re-mention restates it, else keep the existing. Mirrors how a small optional string
    // field is handled; only set when one of them has a value so the field stays lean.
    const incTone = normalizeTone(incoming?.tone);
    const exTone = normalizeTone(existing?.tone);
    if (incTone) out.tone = incTone;
    else if (exTone) out.tone = exTone;
    // SCENE + SOURCE STRANDS (Spiderweb 2): FIRST-WINS (origin). A fact records the scene it was
    // ESTABLISHED in — a later re-mention must NOT move it (mirrors validAt). Because the upsert
    // merge spreads `...existing, ...fact, ...sal`, the incoming `fact.sceneNo/Name/sourceMsg`
    // would otherwise clobber the origin; we re-assert the EXISTING values here (this fn's return
    // is spread LAST). When `existing` has none (e.g. an old back-compat fact being re-mentioned),
    // adopt the incoming so the strand is filled once. The SUPERSESSION path deliberately does NOT
    // route through here for the live fact's new value (it spreads `...existing, ...fact, ...sal`
    // too, but the design wants the live fact to carry the NEW scene while the `__was` snapshot —
    // built from `existing` before merge — keeps the old scene); see upsertFact's supersession
    // branch, which passes the SUPERSEDED existing as `existing` so its origin is preserved on the
    // snapshot, and lets the incoming scene advance the live fact.
    const exNo = Number.isInteger(existing?.sceneNo) ? existing.sceneNo : null;
    const incNo = Number.isInteger(incoming?.sceneNo) ? incoming.sceneNo : null;
    if (exNo !== null) {
        out.sceneNo = exNo;
        if (existing?.sceneName) out.sceneName = existing.sceneName;
    } else if (incNo !== null) {
        out.sceneNo = incNo;
        if (incoming?.sceneName) out.sceneName = incoming.sceneName;
    }
    const exSrc = typeof existing?.sourceMsg === 'string' && existing.sourceMsg ? existing.sourceMsg : '';
    const incSrc = typeof incoming?.sourceMsg === 'string' && incoming.sourceMsg ? incoming.sourceMsg : '';
    if (exSrc) out.sourceMsg = exSrc;
    else if (incSrc) out.sourceMsg = incSrc;
    return out;
}

// =============================================================================
// USE-IT-OR-LOSE-IT — use-driven fact strengthening (never-delete).
//
// When a fact is actually committed into the Writer's injected context (the single
// commit point in runPipelineInline), it has earned its slot — we want it to STAY hot and
// keep winning scarce retrieval slots. So we bump useCount + lastUsedAt, which both
// salience functions fold in (recency refresh + bounded frequency bonus). Facts that never
// get injected decay on recency alone and drift cold — but are NEVER deleted.
//
// PERSISTENCE CHOICE — DEFERRED MODULE-LEVEL BUFFER (no extra per-turn write). The inline
// pipeline runs PRE-reply; the only post-reply DB write the system already does is the
// Scribe's extraction save (runMemoryExtraction → applyUpdates/saveDatabase +
// saveCurrentToActiveProfile). We must NOT add a standalone saveDatabase just for usage
// marks (gratuitous I/O is the enemy at infinite scale). Mutating the retrieved fact objects
// in place is ALSO unsafe to rely on across the pre/post-reply boundary: getAllDatabases()
// hands out a per-turn CACHED map that can be invalidated between the inline run and the
// extraction (CHAT_CHANGED invalidates; the extraction's own writes reload fresh objects), so
// an in-place bump on a stale object could be discarded before the next save. THEREFORE we
// STAGE the used facts' `category:key` ids in a module-level buffer (markFactsUsed) and DRAIN
// it (applyBufferedFactUsage) at the START of the next extraction — against the FRESHLY-loaded
// databases the extraction is about to persist anyway. The bumps then ride that same save with
// zero extra I/O. This is correct because the buffer keys are identity-stable (category:key)
// and the drain resolves them against whatever objects are currently authoritative.
// =============================================================================

// Pending used-fact ids (`category:key`) accumulated since the last drain. A Set dedupes a
// fact that surfaced in multiple tiers in one turn so it's only bumped once per drain.
let _pendingUsedFactIds = new Set();
// AVATAR SCOPING (audit low-severity finding): the buffer is module-global, so without a scope
// stamp, ids staged under character A could survive a character switch and be drained into
// character B's freshly-loaded map — silently strengthening B's facts that happen to share a
// `category:key` with A's. We stamp the buffer with the avatar it was staged under (derived the
// same way every persistence path derives it: getCharacterAvatar()) and the drain DISCARDS the
// buffer when its stamp differs from the drain-time avatar. Fact storage is avatar-keyed, so a
// same-avatar chat switch draining into the same store is correct and intentionally allowed.
let _pendingUsedFactAvatar = null;

/** Best-effort current avatar for buffer scoping; null when no character is selected. */
function currentUsageAvatar() {
    try { return getCharacterAvatar() || null; } catch { return null; }
}

/**
 * Record that a set of facts were committed into the Writer's injected context this turn, so
 * the next extraction save STRENGTHENS them (useCount/lastUsedAt). Stages identity-stable
 * `category:key` ids in a module-level buffer rather than mutating now — see the rationale
 * block above (the per-turn DB cache may be invalidated before the post-reply save, so an
 * in-place bump can't be relied on; the buffer is drained against the freshly-loaded map the
 * extraction is about to persist). Accepts the retrieval result shape `{fact, category}` (the
 * `fact.key` carries identity). NEVER deletes anything; never triggers its own save.
 * @param {Array<{fact: {key?: string}, category?: string}>} usedFactRefs
 */
export function markFactsUsed(usedFactRefs) {
    if (!Array.isArray(usedFactRefs)) return;
    // Stamp the buffer with the CURRENT avatar (public signature unchanged). If leftover ids from
    // a DIFFERENT character are still staged (their extraction never ran — e.g. the user switched
    // characters mid-turn), discard them rather than let them cross-credit this character's facts.
    const avatar = currentUsageAvatar();
    if (_pendingUsedFactIds.size > 0 && _pendingUsedFactAvatar !== avatar) {
        _pendingUsedFactIds = new Set();
    }
    _pendingUsedFactAvatar = avatar;
    for (const ref of usedFactRefs) {
        const cat = ref?.category;
        const key = ref?.fact?.key;
        if (!cat || !key) continue;
        _pendingUsedFactIds.add(`${cat}:${key}`);
    }
}

/**
 * Drain the pending used-fact buffer against a LIVE databases map, bumping useCount += 1 and
 * setting lastUsedAt = now on each matching stored fact object IN PLACE. Called at the start of
 * the post-reply extraction (runMemoryExtraction) before its own saves. Idempotent per turn: the
 * buffer is cleared once applied, so a fact is bumped at most once per turn even if it surfaced in
 * multiple tiers. NEVER deletes. Logs a single strengthening summary at debug level so it
 * doesn't spam the default Debug view.
 *
 * PERSISTENCE CONTRACT — returns the SET of categories it actually bumped so the caller can make
 * the bumps durable. saveDatabase(db) is a per-category read-modify-write that merges only the
 * passed category into the avatar's stored record (reading the OTHER categories from disk, not
 * from this in-memory map). So a bump on a category the extraction ALSO re-saves rides that save
 * for free (same object), but a bump on a used-but-NOT-extracted category would never reach the
 * working store (the profile copy isn't the load source). The caller therefore persists exactly
 * the bumped categories the extraction didn't already save — minimal, proportionate I/O, never a
 * full extra pass.
 * @param {Object<string, DatabaseSchema>} databases - the live map about to be persisted
 * @param {string} [runId] - turn id to tag the log with (threaded from the extraction run)
 * @returns {string[]} unique category names that had at least one fact strengthened
 */
export function applyBufferedFactUsage(databases, runId) {
    if (_pendingUsedFactIds.size === 0) return [];
    // AVATAR GUARD: the buffer only applies to the character it was staged under. When the drain
    // target's avatar (derived the same way the staging side derives it) differs — the user
    // switched characters between the inline mark and this extraction — DISCARD the buffer
    // entirely: bumping another character's same-keyed facts would be silent cross-contamination,
    // and the marks are meaningless for a store they were never observed in.
    const avatar = currentUsageAvatar();
    if (_pendingUsedFactAvatar !== avatar) {
        addDebugLog('debug', 'Discarded stale used-fact buffer (staged under a different character)', {
            runId, subsystem: 'retrieval', event: 'fact.strengthened', reason: 'AVATAR_MISMATCH_DISCARD',
            data: { staged: _pendingUsedFactIds.size, stagedAvatar: _pendingUsedFactAvatar, drainAvatar: avatar },
        });
        _pendingUsedFactIds = new Set();
        _pendingUsedFactAvatar = null;
        return [];
    }
    // Snapshot + clear up front so a re-entrant call (or a thrown error mid-loop) can't
    // double-apply or strand the buffer.
    const pending = _pendingUsedFactIds;
    _pendingUsedFactIds = new Set();
    if (!databases || typeof databases !== 'object') return [];

    const now = Date.now();
    const strengthened = []; // { id, useCount } for the debug log
    const bumpedCategories = new Set();
    for (const id of pending) {
        const sep = id.indexOf(':');
        if (sep < 0) continue;
        const cat = id.slice(0, sep);
        const key = id.slice(sep + 1);
        const db = databases[cat];
        if (!db || !Array.isArray(db.facts)) continue;
        const fact = db.facts.find(f => f && f.key === key);
        if (!fact) continue; // fact may have been superseded/renamed since — skip, never error
        fact.useCount = Math.max(0, Math.floor(Number(fact.useCount) || 0)) + 1;
        fact.lastUsedAt = now;
        strengthened.push({ id, useCount: fact.useCount });
        bumpedCategories.add(cat);
    }

    if (strengthened.length > 0) {
        addDebugLog('debug', `Strengthened ${strengthened.length} used fact(s) (use-it-or-lose-it)`, {
            runId, subsystem: 'retrieval', event: 'fact.strengthened', reason: 'INJECTED_INTO_WRITER',
            data: { count: strengthened.length, at: now, facts: strengthened, categories: [...bumpedCategories] },
        });
    }
    return [...bumpedCategories];
}

/**
 * Union aliases across a re-mention (Layer A): accumulate nicknames/descriptors rather than
 * overwrite, so each re-mention can add a new way to refer to the subject. Dedupes
 * case-insensitively (keeping first-seen casing), preserves order. Returns undefined when
 * the union is empty so a fact without aliases stays lean (back-compat).
 * @param {string[]|undefined} existing
 * @param {string[]|undefined} incoming
 * @returns {string[]|undefined}
 */
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

/**
 * Union `involved` participants across a re-mention (involved feature) — accumulate entities
 * rather than overwrite, so a re-mention that omits `involved` doesn't wipe a previously
 * derived list. Dedupes case-insensitively (first-seen casing), preserves order. Returns
 * undefined when empty so a fact without participants stays lean (back-compat). Mirrors
 * mergeAliases.
 * @param {string[]|undefined} existing
 * @param {string[]|undefined} incoming
 * @returns {string[]|undefined}
 */
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

// redesign-v2 (S1): mergeEdges/MAX_FACT_EDGES removed with the typedEdges feature (stale
// `edges` fields on old facts are carried through the merge spreads untouched).

/** Prefer an incoming context note; fall back to the existing one. Empty → undefined. */
function mergeContext(existing, incoming) {
    const inc = (typeof incoming === 'string') ? incoming.trim() : '';
    if (inc) return inc;
    const ex = (typeof existing === 'string') ? existing.trim() : '';
    return ex || undefined;
}

/**
 * Find the existing fact a given key would reconcile to (exact match first, then a
 * conservative normalized-key match). Returns the matched fact or null. Used by
 * applyUpdates to classify a write as NEW vs UPDATED vs SKIPPED with the SAME
 * matching rule upsertFact uses, so the status reported to the UI is accurate.
 * @param {DatabaseSchema} db
 * @param {string} key
 * @returns {FactSchema|null}
 */
export function findFactMatch(db, key) {
    if (!db || !Array.isArray(db.facts)) return null;
    const exact = db.facts.find(f => f.key === key);
    if (exact) return exact;
    const norm = normalizeFactKey(key);
    if (norm) {
        const normHit = db.facts.find(f => normalizeFactKey(f.key) === norm);
        if (normHit) return normHit;
    }
    // Mirror upsertFact's reversed pair-status canonicalizer (2b) — key-shape-only, so the
    // NEW/UPDATED classification and the post-write auto-link re-find stay accurate when a
    // reversed `<b>_<a>_status` write gets re-keyed onto the stored orientation.
    const pairMatch = /^([a-z0-9]+)_([a-z0-9]+)_status$/.exec(String(key || '').trim().toLowerCase());
    if (pairMatch && pairMatch[1] !== pairMatch[2]) {
        const reversedKey = `${pairMatch[2]}_${pairMatch[1]}_status`;
        return db.facts.find(f => !isSequenceFact(f) && String(f.key || '').trim().toLowerCase() === reversedKey) || null;
    }
    return null;
}

/**
 * Would writing `fact` into `db` materially change stored state (NEW or UPDATED), or is it
 * a no-op re-upsert of what is already stored (SKIPPED)? Same classification applyUpdates
 * (agent-memory.js) performs before committing a Scribe batch: match with the SAME rule
 * upsertFact uses (sequence facts match by exact key only), then compare value + tags.
 * Used by the review-popup / catch-up "Save edited" commits to gate the cross-key supersede
 * rules on genuine new writes — the pending queue re-upserts ALREADY-SAVED items, and an
 * unchanged death/departure/loss item must never re-fire a rule (it could wrongly retire
 * same-subject state facts written AFTER the original trigger, e.g. a post-death
 * current_location pinned via the Writer's remember_fact tool).
 * @param {DatabaseSchema} db
 * @param {FactSchema|Object} fact - incoming write (update/queue-item shaped is fine)
 * @returns {boolean} true when the write is NEW or materially UPDATED
 */
export function isMaterialFactWrite(db, fact) {
    if (!fact) return false;
    const matched = fact.track
        ? (db?.facts?.find(f => f.key === fact.key) || null)
        : findFactMatch(db, fact.key);
    if (!matched) return true; // NEW
    if (!factValuesEqual(matched.value, fact.value)) return true; // UPDATED (value changed)
    const norm = arr => (Array.isArray(arr) ? arr : [])
        .map(t => String(t).trim().toLowerCase())
        .filter(Boolean)
        .sort();
    const a = norm(matched.tags);
    const b = norm(fact.tags);
    return a.length !== b.length || a.some((t, i) => t !== b[i]); // UPDATED (tags) vs SKIPPED
}

/**
 * Normalize a fact key for conservative reconcile-on-write matching.
 * Strips separators and a trailing plural 's' so cosmetic variants of the SAME property collapse
 * to one canonical form while genuinely different properties stay distinct. Returns '' for empty
 * input.
 *   hair_color / haircolor            -> "haircolor"
 *   trait / traits                    -> "trait"
 *
 * NOTE — numeric suffixes are NO LONGER stripped (corruption fix). `_1`/`_2`/`_3` are the Scribe's
 * INTENTIONAL idiom for DISTINCT enumerated items (its own examples mint `possession_1`,
 * `clothing_condition_1`/`_2`, `location_1`/`_2`/`_3`). The old `\d+$`-strip collapsed
 * `clothing_condition_1` and `_2` to one key, so the second item SUPERSEDED (effectively lost) the
 * first. Keeping the number distinct preserves both. True same-slot state evolution is still
 * handled by (a) the exact-key path, (b) the parallel-state matcher (same subject + aspect), and
 * (c) the explicit `~` supersession marker — none of which rely on digit-stripping.
 */
function normalizeFactKey(key) {
    let k = String(key || '').toLowerCase().trim();
    if (!k) return '';
    k = k.replace(/[_\-\s]+/g, '');      // drop all separators (keep any trailing digits distinct)
    if (k.length > 3 && k.endsWith('s')) k = k.slice(0, -1); // crude singularize
    return k;
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

// =============================================================================
// AUTOMATIC ASSOCIATIVE LINKING (A-MEM style, lexical, DETERMINISTIC, zero-API).
//
// GOAL. When a fresh fact lands, auto-connect it to the most-related EXISTING active facts so
// that asking about any one surfaces the others — by lexical/structural overlap alone (no LLM).
//
// HOW THE LINK SURFACES. We do NOT touch retrieval: we only populate `fact.relationships`, which
// the retrieval path ALREADY follows. A primary hit's `relationships.primary`/`secondary` refs are
// tokenized and resolved through the token index (see searchFactsIndexed's expansion + the
// expandLinks fallback that reads `result.fact.relationships.primary`). A ref is admitted when the
// target fact's `category key tags` text CONTAINS the ref string, so a ref must be a token that
// (a) appears in the target's byToken index and (b) is a substring of its identifiers. A fact's
// own `key` satisfies BOTH — so we record links as the TARGET FACT's KEY (link by IDENTITY of a
// real stored fact, never an invented token). Refs are deduped + lowercased to match resolution.
//
// RELATEDNESS SIGNALS (priority order, mirroring the scope-graph the rest of the code uses):
//   1. SHARED LOCATION or SHARED `involved` member → PRIMARY (the place/people graph — the
//      HIGH-PRECISION structural ties: a shared place-at-a-time or a shared participant is
//      discriminating, low-degree, and scene-relevant).
//   2. SAME SUBJECT (index.bySubject) → SECONDARY (ANTI-HUB demotion). Sharing the owning
//      subject is the LEAST discriminating signal: a hub subject (a character that appears in
//      dozens of facts) makes every one of its facts a same-subject sibling, so leaving these
//      PRIMARY let one hub flood the primary tier at retrieval and crowd out the decisive sparse
//      facts. Demoting pure same-subject ties to the capped secondary tier keeps them findable
//      while reserving primary for the higher-precision shared-location/involved links above.
//   3. LEXICAL TOKEN OVERLAP (index.byToken) ≥ AUTOLINK_MIN_TOKEN_OVERLAP shared meaningful
//      tokens → SECONDARY (weaker, topical co-occurrence).
// HARD BOUNDS: cap primary + secondary refs (AUTOLINK_MAX_PRIMARY/SECONDARY); skip self, skip
// inactive/superseded targets, dedupe, and never clobber existing (manual or prior) links — we
// UNION into them via mergeRelationships. The work is O(matching facts), never O(all facts),
// because every candidate set comes from an index bucket (bySubject/byToken).
// =============================================================================

const AUTOLINK_MAX_PRIMARY = 5;
const AUTOLINK_MAX_SECONDARY = 5;
const AUTOLINK_MIN_TOKEN_OVERLAP = 2; // ≥ this many shared >3-char tokens to earn a secondary link

/**
 * Canonical link ref for a target fact: its `key`, lowercased + trimmed. Recording the KEY (not an
 * invented token) makes the link an IDENTITY reference to a real stored fact, and the key resolves
 * cleanly through the retrieval ref-expansion (the key is both an index token and a substring of
 * the target's identifiers). Returns '' for a keyless fact.
 * @param {FactSchema} fact
 * @returns {string}
 */
function autoLinkRef(fact) {
    return String(fact?.key || '').trim().toLowerCase();
}

/**
 * AUTO-LINK a freshly-written fact to related EXISTING active facts (deterministic, zero-API).
 * Mutates `fact.relationships` IN PLACE, UNIONING new refs into any existing (manual/prior) links
 * via mergeRelationships — never clobbering. Targets are pulled from the prebuilt in-memory index
 * (bySubject / byToken), so the cost is O(matching facts). Bounded hard by AUTOLINK_MAX_PRIMARY /
 * AUTOLINK_MAX_SECONDARY. Skips self (same category:key), inactive/superseded targets, and dupes.
 *
 * ORDERING/CORRECTNESS: the caller passes the index as it was at the START of the write batch (see
 * applyUpdates) — the index is name-agnostic + active-only and is NOT mutated here, so a fact added
 * earlier in the same batch simply isn't a candidate yet (acceptable: the next turn's index will
 * include it, and the earlier fact may already link forward to this one). We read the index; we do
 * NOT rebuild it per fact (which would be O(all) per fact). Pure aside from mutating `fact`.
 *
 * BACK-LINKING DECISION (intentionally NOT done here): we record FORWARD links only. The
 * structural signals (same-subject / shared-location / shared-involved) are ALREADY symmetric at
 * retrieval time — expandLinks traverses the scope graph (subject⇄place⇄people) in BOTH directions
 * off the candidate set, so querying either side surfaces the other regardless of which fact stores
 * the ref. Adding a reverse ref onto each target would mutate facts in OTHER categories that the
 * current extraction is NOT already saving, forcing extra attachment writes (I/O bloat the project
 * explicitly avoids). So we skip reverse-ref writes; the forward link + symmetric scope-graph cover
 * the bidirectional case. TODO(optional): if a target happens to live in a category the batch is
 * already re-saving, a reverse ref could ride that save for free — left out to keep this bounded.
 *
 * Logs `fact.autolink` (debug level, standing rule) with the link counts + chosen targets.
 * @param {{bySubject: Map, byToken: Map}} index - the per-turn in-memory fact index
 * @param {FactSchema} fact - the freshly-upserted fact (mutated in place)
 * @param {string} category - the fact's owning category (to skip self by category:key identity)
 * @param {string} [runId] - optional correlation id for the debug log
 * @returns {{primary: string[], secondary: string[]}} the refs actually added (post-cap, post-dedupe)
 */
export function autoLinkFact(index, fact, category, runId) {
    const empty = { primary: [], secondary: [] };
    if (!index || !fact || typeof fact !== 'object') return empty;
    if (!isActiveFact(fact)) return empty; // never link FROM a superseded snapshot
    const selfId = `${category}:${fact.key}`;
    const selfRef = autoLinkRef(fact);

    // A candidate is admissible iff it's a DIFFERENT, ACTIVE stored fact. (The index already holds
    // only active facts, but guard anyway in case a caller passes a hand-built index.)
    const admissible = (entry) => {
        const t = entry && entry.fact;
        if (!t || typeof t !== 'object') return false;
        if (`${entry.category}:${t.key}` === selfId) return false; // skip self
        if (!isActiveFact(t)) return false;
        return true;
    };

    // ---- PRIMARY candidates: shared location OR shared involved member (HIGH-PRECISION only).
    // Pure same-subject ties are NO LONGER primary (anti-hub demotion); they fall to secondary
    // below so a hub subject can't monopolize the primary tier. ----
    const primaryRefs = new Set();
    const addPrimary = (entry) => {
        if (primaryRefs.size >= AUTOLINK_MAX_PRIMARY) return;
        if (!admissible(entry)) return;
        const ref = autoLinkRef(entry.fact);
        if (ref && ref !== selfRef) primaryRefs.add(ref);
    };

    // Signal 1 — SHARED LOCATION + SHARED `involved` member. The `location`/`involved` tokens are
    // indexed under byToken (they are part of a fact's key/value/tags for most facts) but the most
    // reliable structural match is: a candidate whose OWN location/involved overlaps ours. We pull
    // candidate sets cheaply by tokenizing our location/involved and unioning their byToken buckets,
    // then keep only those that genuinely SHARE the structural field (not just a stray token hit).
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

    // ---- SECONDARY candidates: same-subject ties (anti-hub demotion), then lexical overlap. ----
    const secondaryRefs = new Set();
    const addSecondary = (entry) => {
        if (secondaryRefs.size >= AUTOLINK_MAX_SECONDARY) return;
        if (!admissible(entry)) return;
        const ref = autoLinkRef(entry.fact);
        if (!ref || ref === selfRef) return;
        if (primaryRefs.has(ref)) return; // already a stronger (primary) location/involved link
        secondaryRefs.add(ref);
    };

    // Signal 2 — SAME SUBJECT → SECONDARY (was primary; demoted as the anti-hub fix). Filled
    // FIRST among the secondary candidates because a shared subject is a real structural tie
    // (stronger than stray lexical co-occurrence) — but capped by AUTOLINK_MAX_SECONDARY so a
    // hub subject's dozens of siblings can't all land even here.
    const subject = deriveSubject(fact);
    if (subject) {
        for (const entry of (index.bySubject.get(subject) || [])) {
            if (secondaryRefs.size >= AUTOLINK_MAX_SECONDARY) break;
            addSecondary(entry);
        }
    }

    // Signal 3 — LEXICAL TOKEN OVERLAP ≥ AUTOLINK_MIN_TOKEN_OVERLAP → SECONDARY.
    // Tally how many of OUR meaningful tokens each candidate fact shares (via the token index),
    // then admit the highest-overlap facts as secondary links until the cap. Skips anything already
    // linked as primary (a stronger tie supersedes the weaker lexical one) and self/inactive.
    const myTokens = factTokens(fact); // >3-char tokens of key+value+tags+aliases (index-consistent)
    if (myTokens.length > 0) {
        const overlap = new Map(); // `category:key` -> { entry, count }
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
            addSecondary(entry); // dedupes against same-subject secondaries + primary already added
        }
    }

    const primary = [...primaryRefs];
    const secondary = [...secondaryRefs];
    if (primary.length === 0 && secondary.length === 0) return empty;

    // UNION the new refs into any existing (manual/prior) relationships — never clobber.
    fact.relationships = mergeRelationships(fact.relationships, { primary, secondary, tertiary: [] });

    addDebugLog('debug', `Auto-linked fact: [${category}] ${fact.key} (+${primary.length} primary, +${secondary.length} secondary)`, {
        subsystem: 'db', event: 'fact.autolink', runId,
        data: { key: fact.key, category, primary: primary.length, secondary: secondary.length, targets: [...primary, ...secondary] },
    });
    return { primary, secondary };
}

/**
 * Remove a fact from a database
 * @param {DatabaseSchema} db
 * @param {string} key
 * @returns {DatabaseSchema}
 */
export function removeFact(db, key) {
    db.facts = db.facts.filter(f => f.key !== key);
    db.updatedAt = Date.now();
    return db;
}

/**
 * Get character names to filter from keyword matching (they appear in every fact)
 * @returns {Set<string>} lowercased character name words
 */
function getCharacterNameWords() {
    const names = new Set();
    try {
        const context = getContext();
        const charName = context.characters?.[context.characterId]?.name || '';
        const userName = context.name1 || '';
        for (const name of [charName, userName]) {
            for (const word of name.split(/\s+/)) {
                if (word.length > 2) names.add(word.toLowerCase());
            }
            // ALSO union in segmented word tokens (min 2): an unspaced CJK full name yields the
            // whole string from the whitespace split above (fine), but the segmented pieces are
            // what actually appear as per-token index buckets, so both forms must be filtered.
            for (const tok of wordTokens(name, { min: 2 })) names.add(tok);
        }
    } catch (e) { /* ignore */ }
    return names;
}

/**
 * Produce a COMPACT keys-only inventory of all stored facts as `Category/key`
 * (one per line, no values) so it can be cheaply injected into Agent 1's prompt as
 * a menu of EXACT keys it can request. Values are intentionally omitted to keep the
 * inventory token cost low; Agent 1 only needs to know what exists, not its content.
 * @param {Object<string, DatabaseSchema>} databases - All databases
 * @returns {string} Newline-separated `Category/key` list (empty string if none)
 */
export function summarizeKeys(databases) {
    if (!databases || Object.keys(databases).length === 0) return '';
    const lines = [];
    for (const [category, db] of Object.entries(databases)) {
        for (const fact of (db.facts || [])) {
            // Supersession: omit inactive history snapshots from the requestable inventory
            // so Agent 1 only sees currently-valid keys (and we don't pay tokens for stale ones).
            if (!isActiveFact(fact)) continue;
            if (fact.key) lines.push(`${category}/${fact.key}`);
        }
    }
    return lines.join('\n');
}

// Canonical category order for the MENU (two-stage retrieval) — now the Layer-1 set.
// Unsorted always last — it's the catch-all and is ALWAYS sent to the finder regardless of
// picks, so listing it last keeps the menu readable. Categories not in this list (custom
// buckets) are appended after, in insertion order, so the menu never silently drops a real
// category. (Old name kept for callers; equals L1_CATEGORIES.)
export const MENU_CATEGORY_ORDER = L1_CATEGORIES;

/** Case-insensitive lookup of a database by category name. Returns [name, db] or null. */
function findDbByCategory(databases, category) {
    const want = String(category || '').trim().toLowerCase();
    if (!want) return null;
    for (const [name, db] of Object.entries(databases)) {
        if (String(name).toLowerCase() === want) return [name, db];
    }
    return null;
}

/**
 * GROUPED (3-level) view of the taxonomy for the SCRIBE drill: every Layer-1 category, its
 * SUB-AREAS, and each sub-area's leaves, rendered compactly so the note-taker navigates
 * families→leaves rather than scanning ~1000 flat labels. Replaces fullTaxonomyMenu in the
 * Scribe prompt (the note-taker picks the MOST SPECIFIC leaf after committing to a category ▸
 * sub-area, which measurably reduces the "collapse to the coarse default" failure). This is a
 * ONE-time prompt-size increase — there is NO second/drill LLM call; the whole grouped tree ships
 * in the single Scribe prompt. The leaf written to `fact.aspect` is still a flat leaf string,
 * validated by normalizeAspect against flatVocab — the sub-area is navigation only, never stored.
 * Format (one line per sub-area):  `Category ▸ SubArea: leaf, leaf, …`.
 * Pure / no DB needed (the vocab is a code constant). Never empty.
 * @returns {string} Multi-line grouped menu (one line per category▸sub-area). Never empty.
 */
export function groupedTaxonomyMenu() {
    const overlay = getTaxonomyOverlay();
    const lines = [];
    for (const cat of effectiveCategories()) {
        const node = TAXONOMY[cat];
        // Built-in sub-areas first (skip for an overlay-only category, which has no node).
        if (node) {
            for (const [subArea, leaves] of Object.entries(node)) {
                lines.push(`${cat} ▸ ${subArea}: ${leaves.join(', ')}`);
            }
        }
        // USER OVERLAY leaves for this category. Place each leaf under its declared sub-area
        // (overlay.subAreas[cat][subArea]) when given; everything else groups under "Custom".
        const extra = Array.isArray(overlay.aspects[cat]) ? overlay.aspects[cat] : [];
        if (!extra.length) continue;
        const declared = (overlay.subAreas[cat] && typeof overlay.subAreas[cat] === 'object') ? overlay.subAreas[cat] : {};
        // Map leaf -> its declared sub-area (first match wins); the rest fall under "Custom".
        const leafSub = new Map();
        for (const [subArea, leaves] of Object.entries(declared)) {
            for (const l of (Array.isArray(leaves) ? leaves : [])) {
                const leaf = String(l || '').trim().toLowerCase();
                if (leaf && !leafSub.has(leaf)) leafSub.set(leaf, String(subArea));
            }
        }
        // Group overlay leaves by sub-area, preserving insertion order; built-in leaves are
        // excluded (they already rendered above) so we never duplicate a label.
        const builtinLeaves = node ? new Set(Object.values(node).flat()) : new Set();
        const groups = new Map(); // subArea -> leaf[]
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

/**
 * COMPACT (families-only) view of the taxonomy for the SCRIBE drill: every Layer-1 category and
 * its SUB-AREA names ONLY — NOT the ~940 individual leaves. Renders one line per category:
 * `Category: SubArea, SubArea, …` (~77 sub-area names total vs. ~940 leaves), shrinking the
 * inlined Scribe menu from ~3.1K tokens to a few hundred. This is the menu the Scribe SEES; it
 * does NOT need to see every leaf to file correctly, because write-time `normalizeAspect` /
 * `findExistingLeaf` already SNAP an emitted aspect to a real leaf (or the category/sub-area
 * default), and the user-add / AI-expand overlay still operates on the full vocab. The Scribe is
 * instructed to pick the most specific leaf it knows within the chosen category ▸ sub-area; the
 * snapping layer is the authority on validity. Overlay sub-areas are appended (a flat "Custom"
 * bucket for overlay leaves without a declared sub-area, matching groupedTaxonomyMenu).
 * Pure / no DB needed (the vocab is a code constant). Never empty.
 * @returns {string} Multi-line families-only menu (one line per category). Never empty.
 */
export function groupedTaxonomySubAreas() {
    const overlay = getTaxonomyOverlay();
    const lines = [];
    for (const cat of effectiveCategories()) {
        const node = TAXONOMY[cat];
        const subAreas = [];
        // Built-in sub-area names (order preserved); skipped for an overlay-only category.
        if (node) {
            for (const subArea of Object.keys(node)) subAreas.push(subArea);
        }
        // OVERLAY sub-areas for this category: any declared sub-area name plus a flat "Custom"
        // bucket when there are overlay leaves with no declared sub-area (mirrors groupedTaxonomyMenu).
        const extra = Array.isArray(overlay.aspects[cat]) ? overlay.aspects[cat] : [];
        if (extra.length) {
            const declared = (overlay.subAreas[cat] && typeof overlay.subAreas[cat] === 'object') ? overlay.subAreas[cat] : {};
            const declaredLeaves = new Set();
            for (const [subArea, leaves] of Object.entries(declared)) {
                if (!subAreas.includes(subArea)) subAreas.push(subArea);
                for (const l of (Array.isArray(leaves) ? leaves : [])) {
                    const leaf = String(l || '').trim().toLowerCase();
                    if (leaf) declaredLeaves.add(leaf);
                }
            }
            const builtinLeaves = node ? new Set(Object.values(node).flat()) : new Set();
            const hasUndeclared = extra.some((raw) => {
                const leaf = String(raw || '').trim().toLowerCase();
                return leaf && !builtinLeaves.has(leaf) && !declaredLeaves.has(leaf);
            });
            if (hasUndeclared && !subAreas.includes('Custom')) subAreas.push('Custom');
        }
        if (subAreas.length) lines.push(`${cat}: ${subAreas.join(', ')}`);
    }
    return lines.join('\n');
}

/**
 * Silent dedupe-janitor pass over a single database (refinement #12). Rebuilds the
 * fact list by re-feeding every ACTIVE non-sequence fact through upsertFact into a fresh
 * copy, so the existing reconcile-on-write machinery (normalized-key variants + parallel
 * changeable-state collapse + supersession) merges near-duplicates that accumulated over
 * a long session. Sequence/track facts and superseded history snapshots are preserved
 * verbatim and never collapsed (they form ordered/historical chains). Pure in-memory; the
 * CALLER persists via saveDatabase. Returns { db, before, after, merged }.
 *
 * Idempotent: a DB with no duplicates round-trips to itself (merged === 0).
 * @param {DatabaseSchema} db
 * @returns {{db: DatabaseSchema, before: number, after: number, merged: number}}
 */
export function dedupeDatabase(db) {
    if (!db || !Array.isArray(db.facts)) return { db, before: 0, after: 0, merged: 0 };
    const before = db.facts.length;
    // Partition: sequence steps + inactive history snapshots are preserved as-is; only the
    // active non-sequence facts are re-reconciled against each other.
    const preserved = [];
    const reconcilable = [];
    for (const f of db.facts) {
        if (!f || typeof f !== 'object') continue;
        if (isSequenceFact(f) || f.active === false) preserved.push(f);
        else reconcilable.push(f);
    }
    const rebuilt = createEmptyDatabase(db.category);
    rebuilt.facts = [...preserved]; // keep history/sequence so parallel-state collapse still sees context
    for (const f of reconcilable) {
        // Re-feed a shallow copy so upsertFact's spreads can't mutate the original objects.
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

// Internal helpers

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
        const { deleteFileFromServer } = await import('../../../../chats.js');
        await deleteFileFromServer(url);
    } catch (e) {
        console.error('[BFMemory] Failed to delete file:', e);
    }
}

// =============================================================================
// DEBUG-LOG FILE (persistent verbose firehose). The verbose debug log is far too
// large for chat_metadata (which round-trips into the chat .jsonl), so the FULL
// buffer — including verbose entries — is persisted to its OWN character-attachment
// file, REUSING the exact same attachment infrastructure the fact DBs use
// (uploadFileAttachment to write, fetch() to read, deleteFileFromServer to replace).
//
// SCOPING: ST attachments are stored per-CHARACTER-AVATAR, but the debug log is
// per-CHAT, so the filename embeds a sanitized chatId — each chat gets its own log
// file under the character's attachment list. A character with N chats accumulates
// N log files (single-file-per-chat, overwritten in place like saveDatabase).
//
// COST NOTE: like saveDatabase, every write RE-UPLOADS the whole file (ST has no
// append API). settings.js therefore THROTTLES writes (not per-entry) and only
// flushes on a throttled cadence + beforeunload. The byte/entry cap there bounds the
// re-upload size.
// =============================================================================

const DEBUGLOG_PREFIX = 'bf_mem_debuglog_';

/** Sanitize a chatId into a filesystem-safe token (mirrors saveDatabase's category sanitizer). */
function safeChatToken(chatId) {
    return String(chatId || 'default').toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 80) || 'default';
}

/** The attachment file name for a chat's debug log. */
function debugLogFileName(chatId) {
    return `${DEBUGLOG_PREFIX}${safeChatToken(chatId)}.json`;
}

/**
 * Read the persisted debug-log file for a chat back into a plain array of entries.
 * Returns [] when there is no file (new chat), the character has no avatar, or any
 * fetch/parse error — file I/O must NEVER throw into the pipeline.
 * @param {string} chatId
 * @returns {Promise<Array>}
 */
export async function loadDebugLogFile(chatId) {
    try {
        const avatar = getCharacterAvatar();
        if (!avatar) return [];
        const context = getContext();
        const attachments = context.extensionSettings?.character_attachments?.[avatar] || [];
        const fileName = debugLogFileName(chatId);
        const attachment = attachments.find(a => a.name === fileName);
        if (!attachment) return []; // new chat — no file yet (back-compat / missing-file path)
        const content = await fetchAttachmentContent(attachment.url);
        if (!content) return [];
        const parsed = JSON.parse(content);
        // File shape: { v, chatId, savedAt, entries: [...] }. Tolerate a bare array too.
        const entries = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.entries) ? parsed.entries : []);
        return entries.filter(e => e && typeof e === 'object' && typeof e.message === 'string');
    } catch (e) {
        console.error('[BFMemory] Failed to load debug-log file', e);
        return [];
    }
}

/**
 * Persist the FULL debug-log buffer (incl. verbose) to the chat's own attachment file,
 * overwriting any existing file (single-file overwrite, exactly like saveDatabase).
 * Wrapped end-to-end in try/catch — a failed upload must never break the pipeline or
 * lose the in-RAM buffer.
 * @param {string} chatId
 * @param {Array} entries - the full RAM ring buffer (newest-first), already capped by caller
 * @returns {Promise<boolean>} true on a successful upload
 */
export async function saveDebugLogFile(chatId, entries) {
    try {
        const avatar = getCharacterAvatar();
        if (!avatar) return false; // no character — nothing to attach to (stays in RAM)

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

        // Remove existing log file for this chat (overwrite-in-place).
        const existingIdx = attachments.findIndex(a => a.name === fileName);
        if (existingIdx >= 0) {
            try { await deleteAttachmentFile(attachments[existingIdx].url); } catch { /* ignore */ }
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

/**
 * Delete a chat's debug-log file (used by "clear logs"). Best-effort; never throws.
 * @param {string} chatId
 */
export async function deleteDebugLogFile(chatId) {
    try {
        const avatar = getCharacterAvatar();
        if (!avatar) return;
        const context = getContext();
        const attachments = context.extensionSettings?.character_attachments?.[avatar] || [];
        const fileName = debugLogFileName(chatId);
        const idx = attachments.findIndex(a => a.name === fileName);
        if (idx >= 0) {
            try { await deleteAttachmentFile(attachments[idx].url); } catch { /* ignore */ }
            attachments.splice(idx, 1);
            // Flush the debounced save (mirror saveDebugLogFile) so the attachment-list change can't
            // be lost if the chat is closed/switched before the debounce fires (the file reappears).
            context.saveSettingsDebounced?.();
            if (typeof context.saveSettingsDebounced?.flush === 'function') context.saveSettingsDebounced.flush();
        }
    } catch (e) {
        console.error('[BFMemory] Failed to delete debug-log file', e);
    }
}

/**
 * @typedef {Object} DatabaseSchema
 * @property {string} category - Database category name
 * @property {FactSchema[]} facts - Array of facts
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} FactSchema
 * @property {string} key - Fact identifier (e.g. "coffee_preference", "first_meeting")
 * @property {string} value - Fact content
 * @property {string[]} tags - Cross-reference tags (e.g. ["allergy", "food"])
 * @property {string[]} knownBy - Characters who know this fact
 * @property {Object} relationships - Tier links to other categories
 * @property {string[]} relationships.primary
 * @property {string[]} relationships.secondary
 * @property {string[]} relationships.tertiary
 * @property {number} lastUpdated
 * @property {string} [source] - Message reference where fact was established
 * @property {string} [context] - OPTIONAL prose note giving the situation around a fact
 *   (Feature #3). Injection-only and EXCLUDED from searchFactsIndexed() match text. Absent on
 *   facts written by older versions (backward-compatible).
 * @property {string[]} [aliases] - OPTIONAL alternative names/nicknames/descriptors the
 *   fact's subject might be referred to by in a future message (Layer A of the retrieval
 *   cascade). MATCH-ONLY: folded into searchFactsIndexed() match text so a paraphrase can satisfy
 *   a keyword hit, but NEVER shown to the writer (excluded from formatFactsForWriter,
 *   exactly like `context`). Unioned (deduped) across re-mentions in upsertFact. Absent on
 *   facts from older versions (backward-compatible — behaves exactly like no aliases).
 * @property {string} [track] - OPTIONAL timeline name (Feature #4). Presence marks this
 *   fact as one ordered step in a sequence (e.g. a location track). Sequence facts are
 *   exempt from reconcile-on-write collapse.
 * @property {number} [ord] - OPTIONAL monotonic step number within `track` (1-based),
 *   auto-assigned at write time.
 * @property {number} [importance] - OPTIONAL salience 1-5 (Feature: importance/kind).
 *   How foundational/poignant the fact is (5 = core identity, 1 = trivial transient).
 *   Default 3 when absent (see DEFAULT_IMPORTANCE). Drives salience-aware eviction and
 *   retrieval ordering. Absent on facts from older versions (backward-compatible).
 * @property {('trait'|'state'|'event'|'moment')} [kind] - OPTIONAL fact kind. `trait` = durable
 *   (age, name, personality); `state` = current/transient (mood, current goal/location);
 *   `event` = something that happened (often a track step); `moment` = an EPISODIC scene beat
 *   (a first, a turning point, a charged exchange) remembered WITH its emotional tone — like an
 *   event but emotionally sticky (slower decay; see HALF_LIFE_DAYS) and append-only (NEVER
 *   supersedes). Default 'trait' when absent (see DEFAULT_KIND). Modulates how fast a fact
 *   decays during cold-tiering/retrieval.
 * @property {boolean} [active] - OPTIONAL temporal-validity flag (supersession feature).
 *   ABSENT or `true` => currently valid (the default for every fact ever written). Set to
 *   `false` when a later write supersedes this fact's value (a `state` that changed). A
 *   superseded fact is RETAINED for history but excluded from the normal writer-injection
 *   path and is the first to be shed under the eviction cap. Backward-compatible: older
 *   facts have no `active` field and are treated as active.
 * @property {number} [supersededAt] - OPTIONAL ms timestamp when this fact was superseded
 *   (i.e. when `active` was set false). Doubles as `validTo`. Absent while active.
 * @property {string} [supersededBy] - OPTIONAL key of the fact that replaced this value
 *   (history breadcrumb). For in-place supersession the key is unchanged, so this equals
 *   the fact's own key. When a cross-key supersede rule retired the fact (crossKeySupersede
 *   feature) this is instead a `Category/key` CROSS-REF to the TRIGGERING fact (e.g.
 *   `Events/mira_death_event`) — consumers must accept both forms. Absent while active.
 * @property {string} [aspect] - OPTIONAL Layer-2 aspect (3-layer model): a granular,
 *   character-agnostic sub-bucket WITHIN the fact's Layer-1 `category`, picked from a FIXED
 *   per-category vocab (see TAXONOMY). Emitted by Agent 3 via the `aspect:` marker; when
 *   absent/invalid it resolves to the category's default aspect via deriveAspect(). This is
 *   the menu's Layer-2 branch axis (replacing the old character-as-subject branch).
 *   Backward-compatible: facts without it resolve to the default aspect on read.
 * @property {string} [subject] - OPTIONAL subject axis (feature: subject axis): the who/what
 *   the fact is about (a character or place name, e.g. `<name>`). Emitted by Agent 3 via the
 *   `subj:` marker; when absent it is DERIVED deterministically from the key prefix (the
 *   token before the first underscore) by deriveSubject(). Will become a retrieval index
 *   axis. Backward-compatible: facts without it derive a subject from the key on read.
 * @property {(number|string)} [confidence] - OPTIONAL provenance: how sure the fact is.
 *   Either a 0-1 number or one of `low`/`med`/`high` (Agent 3 emits via the `conf:` marker).
 *   Absent on older facts (backward-compatible).
 * @property {number} [validAt] - OPTIONAL provenance: the source message index (or ms time)
 *   at which the fact became true. Defaults to the source message index at write time.
 *   Absent on older facts (backward-compatible). NOTE: this is an ORDERING integer, DISTINCT from
 *   the bi-temporal story-world `validFrom`/`validUntil` strings below.
 * @property {string} [validFrom] - OPTIONAL bi-temporal validity (opt-in `biTemporal` feature):
 *   WHEN the fact is true in the STORY WORLD (free-form: an in-story date, an age, a labelled era),
 *   distinct from when it was recorded — so flashbacks/time-skips stay consistent (cf. Graphiti/Zep
 *   valid_at). Emitted by Agent 3 via the `from:` marker; FIRST-WINS at merge (mirrors validAt).
 *   Absent unless the feature is enabled and the writer supplied it (backward-compatible).
 * @property {string} [validUntil] - OPTIONAL bi-temporal validity (opt-in `biTemporal` feature):
 *   WHEN the fact stopped being true in the STORY WORLD (free-form), e.g. a past job or former home
 *   (cf. Graphiti/Zep invalid_at). Emitted via the `until:` marker; ALSO auto-stamped on the OUTGOING
 *   snapshot at supersession (the incoming fact's `validFrom`, else current time) when not already
 *   set. DISTINCT from `supersededAt` (the RECORD-time end). Absent on older facts (back-compatible).
 * @property {number} [sceneNo] - OPTIONAL scene strand (Spiderweb 2): the monotonic scene NUMBER
 *   the fact was ESTABLISHED in (origin). Stamped at write from the current scene card; FIRST-WINS
 *   (a re-mention never moves it — mirrors validAt). The supersession path is the one exception:
 *   the live fact may advance to the new scene while the retained `__was` snapshot keeps the old.
 *   Indexed under `bySceneNo`; drives same-scene expansion + getFactsByScene recall. Absent on
 *   older facts (backward-compatible).
 * @property {string} [sceneName] - OPTIONAL scene strand (Spiderweb 2): the scene's name at the
 *   time the fact was established (location-derived by default, optionally Drafter-refined). Paired
 *   with `sceneNo`. Absent on older facts (backward-compatible).
 * @property {string} [sourceMsg] - OPTIONAL source strand (Spiderweb 2): provenance handle for the
 *   message the fact came from (`msg_<idx>`). REUSES the existing `source` index — no new id is
 *   minted. FIRST-WINS like the scene. Absent on older facts (backward-compatible).
 * @property {('character'|'place'|'event')} [scope] - OPTIONAL recall axis (scope feature).
 *   `character` = sticks to a person (traits/state/behavior); `place` = a location/world thing
 *   recalled when the PLACE matters even if its owner is absent; `event` = something that
 *   happened (anchored to place + people + time). Emitted by Agent 3 via the `scope:` marker;
 *   when absent it is INFERRED deterministically from category/track (see deriveScope). Drives
 *   place-filing (deriveSubject files `scope:place` facts under the place, not the character).
 *   Backward-compatible: facts without it infer a scope on read.
 * @property {string[]} [involved] - OPTIONAL participants/entities IN the fact (who/what the
 *   fact concerns), DISTINCT from `knownBy` (who may KNOW it) and `subject` (the primary owner).
 *   Emitted by Agent 3 via the `with:` marker; AUTO-FILLED when omitted from names in `knownBy`
 *   plus capitalized entity tokens in the value. Cheap and OPTIONAL — never required. Pairs with
 *   `location` so retrieval can later traverse place⇄event⇄people. Absent on older facts.
 * @property {string} [about] - OPTIONAL provisional name/descriptor of the real person an NPC
 *   fact is about (NPC drawer feature). Set when a fact about an unnamed/incidental person is
 *   routed to the shared `npc` subject, so a later promotion step can migrate the right facts
 *   out to a named subject. Absent on facts that aren't NPC-drawered (backward-compatible).
 * @property {string} [location] - OPTIONAL where-link for an event (location-link feature): a
 *   place key/subject naming WHERE the fact happened. Emitted by Agent 3 via the `at:` marker on
 *   events. Pairs with `involved` (who) for place⇄event⇄people retrieval. Absent on older facts.
 * @property {string} [tone] - OPTIONAL short emotional descriptor for a `moment`-kind fact
 *   (episodic-memory feature), e.g. "tender", "tense", "bittersweet". Emitted by Agent 3 via the
 *   `tone:` marker; normalized + hard-clamped to <=40 chars (see normalizeTone). Surfaced
 *   compactly to the Writer alongside the note so a moment reads with its feeling. Absent on
 *   ordinary facts and on facts from older versions (backward-compatible).
 * @property {('open'|'resolved')} [thread] - OPTIONAL plot-thread state (open-threads feature).
 *   `open` = a genuinely unresolved plot hook (promise, debt, mystery, unfired Chekhov gun) the
 *   story must come back to — emitted by Agent 3 via the `thread:open` marker (mostly on
 *   `kind:event` facts). Open threads are surfaced in the Big Picture block (getOpenThreads) and
 *   PROTECTED from cold-tiering. `resolved` = the Reflection pass judged the thread concluded
 *   (#THREADS verdict); protection + injection lapse. Merge-safe: upsertFact spreads only keys
 *   present on the incoming fact, so a re-mention without the marker keeps the stored state.
 *   Absent on ordinary facts and on facts from older versions (backward-compatible).
 * @property {number} [threadResolvedAt] - OPTIONAL ms timestamp stamped when the Reflection pass
 *   resolved this fact's thread (paired with thread === 'resolved'). Absent while open.
 * @property {boolean} [cold] - OPTIONAL hot/cold tier flag (infinite-facts feature). ABSENT or
 *   `false` => HOT (the default for every fact ever written). Set to `true` by coldTierOverflow
 *   when a category's active hot non-sequence facts exceed HOT_SET_SIZE — the LOWEST-salience
 *   overflow is cold-tiered instead of DELETED. A cold fact is NEVER removed (stays durable in
 *   IDB + the attachment snapshot) and stays QUERYABLE, but is deprioritized by retrieval/menu
 *   (it fills working-set slots last and is hidden from the planner menu / requestable inventory
 *   unless directly matched). It is UN-COLDED when re-mentioned/updated (upsertFact) or directly
 *   matched by a query (relevance resurrects it). Sequence/track facts and high-importance facts
 *   (importance >= COLD_TIER_PROTECT_IMPORTANCE) are never cold-tiered. Backward-compatible:
 *   facts without `cold` are hot.
 */

/**
 * Return all steps of a sequence track, sorted ascending by ord. Used by retrieval's
 * depth-dice continuity logic (Feature #4).
 * @param {Object<string, DatabaseSchema>} databases
 * @param {string} track
 * @returns {Array<{fact: FactSchema, category: string}>}
 */
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

/**
 * OPEN THREADS (open-threads feature): return the newest ACTIVE, non-cold facts flagged
 * `thread:'open'` — the unresolved plot hooks (promises, debts, mysteries, unfired Chekhov guns)
 * the pipeline surfaces in the Big Picture block until the Reflection pass resolves them.
 * Newest-first by the same birth-order spine collectRecentMoments uses (validAt → sceneNo →
 * lastUpdated), then capped, so on an over-full store the FRESHEST hooks win the line. Skips
 * superseded snapshots and timeline (track) steps. Pure, deterministic, zero-API.
 * @param {Object<string, DatabaseSchema>} databases
 * @param {number} [limit=5] - max threads returned
 * @returns {Array<{category: string, key: string, value: string, context: string}>}
 */
export function getOpenThreads(databases, limit = 5) {
    const out = [];
    for (const [category, db] of Object.entries(databases || {})) {
        for (const fact of (db.facts || [])) {
            if (!fact || typeof fact !== 'object') continue;
            if (fact.active === false || fact.track) continue; // skip history snapshots + timeline steps
            if (fact.cold === true) continue;                  // defensively skip cold (open threads shouldn't be, but manual edits happen)
            if (fact.thread !== 'open') continue;
            out.push({ category, fact });
        }
    }
    // Newest-first by birth-order spine: validAt → sceneNo → lastUpdated (mirrors collectRecentMoments).
    out.sort((a, b) => {
        const av = Number.isInteger(a.fact.validAt) ? a.fact.validAt : -1;
        const bv = Number.isInteger(b.fact.validAt) ? b.fact.validAt : -1;
        if (av !== bv) return bv - av;
        const as = Number.isInteger(a.fact.sceneNo) ? a.fact.sceneNo : -1;
        const bs = Number.isInteger(b.fact.sceneNo) ? b.fact.sceneNo : -1;
        if (as !== bs) return bs - as;
        return (Number(b.fact.lastUpdated) || 0) - (Number(a.fact.lastUpdated) || 0);
    });
    const cap = Math.max(1, Math.floor(Number(limit) || 5));
    return out.slice(0, cap).map(({ category, fact }) => ({
        category,
        key: String(fact.key || ''),
        value: String(fact.value ?? ''),
        context: (typeof fact.context === 'string') ? fact.context : '',
    }));
}

/**
 * SCENE RECALL (Spiderweb 2): return all facts stamped with a given scene, for the "recap the
 * market scene" consumer. Accepts a scene NUMBER (matched on `sceneNo`) OR a scene NAME
 * (case-insensitive, matched on `sceneName`). DELIBERATELY INCLUDES cold-tiered AND superseded
 * (inactive `__was`) facts — a recap wants the WHOLE scene as it was, not just the hot/current set
 * that normal retrieval surfaces. Sorted by validAt/sourceMsg order then key so the recap reads in
 * a stable, roughly-chronological order. Pure, deterministic, zero-API.
 * @param {Object<string, DatabaseSchema>} databases
 * @param {number|string} scene - a scene number (int >= 1) or a scene name (string)
 * @returns {Array<{fact: FactSchema, category: string}>}
 */
export function getFactsByScene(databases, scene) {
    // A number (or a purely-numeric string like "3") => scene-number match; any other non-empty
    // string => scene-name match (case-insensitive).
    let wantNo = null;
    let wantName = '';
    if (typeof scene === 'number') {
        const n = Math.floor(scene);
        if (Number.isInteger(n) && n >= 1) wantNo = n;
    } else if (typeof scene === 'string') {
        const s = scene.trim();
        if (/^\d+$/.test(s)) {
            const n = parseInt(s, 10);
            if (n >= 1) wantNo = n;
        } else if (s) {
            wantName = s.toLowerCase();
        }
    }
    if (wantNo === null && !wantName) return [];

    const out = [];
    for (const [category, db] of Object.entries(databases || {})) {
        for (const fact of (db.facts || [])) {
            if (!fact || typeof fact !== 'object') continue;
            let hit = false;
            if (wantNo !== null) {
                hit = Number.isInteger(fact.sceneNo) && fact.sceneNo === wantNo;
            } else if (wantName) {
                hit = typeof fact.sceneName === 'string' && fact.sceneName.trim().toLowerCase() === wantName;
            }
            if (hit) out.push({ fact, category });
        }
    }
    // Roughly chronological: by validAt (source message index) then key for a stable tie-break.
    out.sort((a, b) => {
        const av = Number.isInteger(a.fact.validAt) ? a.fact.validAt : Number.MAX_SAFE_INTEGER;
        const bv = Number.isInteger(b.fact.validAt) ? b.fact.validAt : Number.MAX_SAFE_INTEGER;
        if (av !== bv) return av - bv;
        return String(a.fact.key).localeCompare(String(b.fact.key));
    });
    return out;
}

// RELATIONSHIP MOMENT-THREAD (Phase 0): hard cap on the returned chain. A relationship arc wants
// enough beats to read as an arc but must never flood the Writer's context — bounded like the
// scene-recall / recall-tool caps elsewhere. When the matched set exceeds this, we keep the
// most-important/newest first (salience), then RE-SORT the kept slice chronologically for output.
const RELATIONSHIP_THREAD_MAX = 16;

/**
 * Normalize a character name to the SAME token form `subject`/`involved` are stored in: trimmed,
 * lowercased, `@`-sigil stripped, and reserved generic placeholders (`char`/`user`/`{{char}}`/
 * `{{user}}`) resolved to the active character/user name (so a caller can pass `{{char}}` or a
 * real name interchangeably). Mirrors the `deriveSubject` normalization so a query name matches
 * the same way the store does. Returns '' for blank input.
 * @param {string} name
 * @returns {string}
 */
function normalizeRelationshipName(name) {
    const n = String(name || '').trim().toLowerCase().replace(/^@/, '').trim();
    if (!n) return '';
    return resolveGenericSubjectToken(n);
}

/**
 * Collect the distinct, normalized set of character tokens a fact touches across BOTH its
 * `subject` axis (the owner) and its `involved` participants — the two axes the relationship
 * pair-tag (`subj:@A | with:@B`) rides on. Each token is `@`-stripped/lowercased/placeholder-
 * resolved the same way `normalizeRelationshipName` does, so membership tests line up with caller
 * names. `deriveSubject` is used for the subject so a key-derived subject (no explicit `subj:`)
 * still participates. Returns a Set.
 * @param {FactSchema} fact
 * @returns {Set<string>}
 */
function relationshipNamesOfFact(fact) {
    const names = new Set();
    const subj = String(deriveSubject(fact) || '').trim();
    if (subj) names.add(subj); // deriveSubject already lowercases / resolves placeholders
    const involved = Array.isArray(fact && fact.involved) ? fact.involved : [];
    for (const raw of involved) {
        const t = normalizeRelationshipName(raw);
        if (t) names.add(t);
    }
    return names;
}

/**
 * RELATIONSHIP MOMENT-THREAD (Phase 0): return the chronological chain of facts binding TWO
 * characters A and B — the "emotional history between this couple" thread the Writer can PULL on
 * a callback (a confession, a betrayal resurfacing, a reunion). This is the surface-computable
 * bridge that survives opposite emotional valence: a fight and a confession share the *pair*
 * `(A,B)` even when they share no place/keyword (see design scene2-C §2).
 *
 * WHAT IT INCLUDES — a fact joins the thread when EITHER:
 *   - both A and B appear across its `subject` + `involved` axes (resolved/normalized,
 *     `@`-stripped, lowercased, placeholder-resolved), i.e. the fact concerns both characters; OR
 *   - it is a Relationships-category fact whose pair (`subject` + `involved`) covers BOTH A and B
 *     (the abstract trust/romance/conflict/history facts that carry the arc).
 *   `kind:'moment'` facts (the emotional beats) are PRIORITIZED (kept first when over the cap) but
 *   the key relationship facts are included so the thread tells the whole arc, not just the beats.
 *
 * COLD + SUPERSEDED — DELIBERATELY INCLUDED (like getFactsByScene's recap): a relationship arc
 * wants the full history, including cold-tiered beats and superseded (`active:false`/`__was`)
 * earlier values, so the callback reads as it actually unfolded.
 *
 * ORDER — chronological by `validAt` (source-message index, the stable birth-order stamp), then
 * `sceneNo`, then `lastUpdated`, then `key` for a stable tie-break. This is the same
 * roughly-chronological spine `getFactsByScene` uses, extended with the scene/update stamps.
 *
 * BOUNDED — capped at RELATIONSHIP_THREAD_MAX. When the matched set is larger, the OVERFLOW is
 * dropped by keeping the most-important/newest first (moments first, then salience), but the
 * RETURNED slice is RE-SORTED chronologically so the output still reads as an arc.
 *
 * DEGENERATE CASES — handled gracefully:
 *   - A == B (after normalization) OR only one name given (B blank): returns THAT character's own
 *     moment thread (their emotional beats — `kind:'moment'` facts they're in), still capped +
 *     chronological. A useful "this person's significant beats" query.
 *   - missing both names / no databases: returns [].
 *   - a one-sided match (only A present, B absent): excluded from the pair thread (it's not a
 *     thread fact) — the single-name path is the explicit way to get one character's beats.
 *
 * Pure, deterministic, zero-API. Sibling of getFactsByScene / getTrackSteps.
 *
 * @param {Object<string, DatabaseSchema>} databases
 * @param {string} nameA - first character name (any of `@A`/`A`/`{{char}}` forms)
 * @param {string} [nameB] - second character name; omit/blank for the single-character moment thread
 * @param {Object} [opts]
 * @param {number} [opts.limit] - optional cap override (clamped 1..RELATIONSHIP_THREAD_MAX)
 * @returns {Array<{fact: FactSchema, category: string}>} chronological, capped thread
 */
export function getRelationshipMomentThread(databases, nameA, nameB, opts = {}) {
    const a = normalizeRelationshipName(nameA);
    const b = normalizeRelationshipName(nameB);
    if (!a && !b) return [];

    // SINGLE-CHARACTER path: one name (or A==B) → that character's own moment beats.
    const single = !b || a === b;
    const who = a || b; // the one resolved name in the single-character case
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
                // Single-character thread: the character's emotional beats (moment-kind facts the
                // character is in). Restrict to moments so this stays "their significant beats",
                // not their whole dossier.
                hit = names.has(who) && kind === 'moment';
            } else {
                // Pair thread: any fact that genuinely concerns BOTH characters — a moment about
                // the two of them, a Relationships fact about the pair (trust/romance/conflict/
                // history), or any other fact whose subject+involved cover both names.
                hit = names.has(a) && names.has(b);
            }
            if (hit) matches.push({ fact, category, kind });
        }
    }

    // CHRONOLOGICAL comparator (the documented stable spine): validAt → sceneNo → lastUpdated → key.
    const chrono = (x, y) => {
        const xv = Number.isInteger(x.fact.validAt) ? x.fact.validAt : Number.MAX_SAFE_INTEGER;
        const yv = Number.isInteger(y.fact.validAt) ? y.fact.validAt : Number.MAX_SAFE_INTEGER;
        if (xv !== yv) return xv - yv;
        const xs = Number.isInteger(x.fact.sceneNo) ? x.fact.sceneNo : Number.MAX_SAFE_INTEGER;
        const ys = Number.isInteger(y.fact.sceneNo) ? y.fact.sceneNo : Number.MAX_SAFE_INTEGER;
        if (xs !== ys) return xs - ys;
        const xu = Number(x.fact.lastUpdated) || 0;
        const yu = Number(y.fact.lastUpdated) || 0;
        if (xu !== yu) return xu - yu;
        return String(x.fact.key).localeCompare(String(y.fact.key));
    };

    if (matches.length <= cap) {
        matches.sort(chrono);
        return matches.map(m => ({ fact: m.fact, category: m.category }));
    }

    // OVER CAP: keep the most-important/newest first — moments before non-moments, then by
    // salience (importance + recency, the same scorer retrieval uses to fill scarce slots), then
    // newest-chronological. Then RE-SORT the kept slice chronologically for the arc-reading output.
    const now = Date.now();
    const kept = matches
        .slice()
        .sort((x, y) => {
            const xm = x.kind === 'moment' ? 1 : 0;
            const ym = y.kind === 'moment' ? 1 : 0;
            if (xm !== ym) return ym - xm; // moments first
            const xsal = salienceScore(x.fact, now);
            const ysal = salienceScore(y.fact, now);
            if (xsal !== ysal) return ysal - xsal; // higher salience first
            return -chrono(x, y); // newest first as the final tiebreak
        })
        .slice(0, cap);
    kept.sort(chrono);
    return kept.map(m => ({ fact: m.fact, category: m.category }));
}
