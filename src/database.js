import { addDebugLog } from './settings.js';
import { wordTokens } from './tokenize.js';
import * as host from './host.js';

const DB_PREFIX = 'bf_memory_db_';

const HOT_SET_SIZE = 50;

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

function uncoldFact(fact, category, reason = 'COLD_REACTIVATED', detail = '') {
    if (!fact || fact.cold !== true) return false;
    delete fact.cold;
    addDebugLog('info', `Fact resurfaced (un-cold): [${category}] ${fact.key}${detail ? ` — ${detail}` : ''}`, {
        subsystem: 'db', event: 'fact.resurfaced', reason,
        data: { category, key: fact.key, salienceScore: Number(salienceScore(fact, Date.now()).toFixed(3)) },
    });
    return true;
}

export function markFactCold(fact, category, reason = 'DEMOTED_LOW_VALUE', detail = '') {
    if (!fact || fact.cold === true) return false;
    fact.cold = true;
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
    const bySceneNo = new Map(); 
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
            if (!isActiveFact(fact)) continue; 
            totalFacts++;
            const entry = { fact, category };
            const aspect = deriveAspect(fact);
            add(byCatAspect, `${catLower}||${aspect}`, entry);
            add(bySubject, deriveSubject(fact), entry);
            for (const tok of factTokens(fact)) add(byToken, tok, entry);

            if (Number.isInteger(fact.sceneNo) && fact.sceneNo >= 1) add(bySceneNo, fact.sceneNo, entry);

            if (isHotFact(fact)) {
                let m = aspectCounts.get(category);
                if (!m) { m = new Map(); aspectCounts.set(category, m); }
                m.set(aspect, (m.get(aspect) || 0) + 1);
            }
        }
    }
    return { byCatAspect, bySubject, byToken, bySceneNo, aspectCounts, totalFacts };
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

async function loadAllDatabases(avatar) {
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
                for (const [cat, sdb] of Object.entries(idbDatabases)) {
                    const localCount = (sdb && Array.isArray(sdb.facts)) ? sdb.facts.length : 0;
                    if (localCount === 0) continue; 
                    const attachCount = (attachMap[cat] && Array.isArray(attachMap[cat].facts)) ? attachMap[cat].facts.length : 0;
                    if (attachCount >= localCount) continue; 
                    const tomb = Number(attachTombs[cat]) || 0;
                    if (tomb > categoryRecency(sdb)) adoptedDeletes.push(cat);
                    else refusedCats.push(cat);
                }
                if (refusedCats.length > 0) {

                    const merged = { ...attachMap };
                    for (const cat of refusedCats) merged[cat] = idbDatabases[cat];
                    await idbPutDatabases(avatar, merged, attachStamp, mergedTombs);
                    addDebugLog('info', 'Rehydrate partially refused: kept local categories the snapshot would SHRINK (clobber guard)', {
                        subsystem: 'db', event: 'db.rehydrated', actor: 'SYSTEM', reason: 'CLOBBER_GUARD',
                        data: {
                            attachStamp, idbStamp, avatar, decision: 'PARTIAL_ADOPT',
                            refusedCategories: refusedCats, tombstoneDeletes: adoptedDeletes,

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

                    categoriesBefore: countCats(idbDatabases), factsBefore: countFacts(idbDatabases),
                    categoriesAfter: countCats(attachMap), factsAfter: countFacts(attachMap),
                },
            });
            return attachMap;
        }

        if (idbHasData) return stripLegacyEmbeddings(rec.databases);
        return {};
    } catch (e) {

        console.error('[BFMemory] IDB load failed; falling back to attachments', e);
        disableIdb('IDB load failed mid-session'); 
        return loadAllDatabasesFromAttachments(avatar);
    }
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

function coldTierOverflow(db) {
    if (!db || !Array.isArray(db.facts)) return;
    const now = Date.now();

    const demotable = [];
    for (const f of db.facts) {
        if (!f || typeof f !== 'object') continue;
        if (!isActiveFact(f)) continue;                                  
        if (isSequenceFact(f)) continue;                                 
        if (f.thread === 'open') continue;                               
        if (clampImportance(f.importance) >= COLD_TIER_PROTECT_IMPORTANCE) continue; 
        demotable.push(f);
    }

    if (demotable.length <= HOT_SET_SIZE) {

        for (const f of demotable) {
            if (f.cold === true) uncoldFact(f, db.category, 'COLD_REACTIVATED', 'hot-set no longer over budget');
        }
        return;
    }

    const ranked = demotable.slice().sort((a, b) => salienceScore(b, now) - salienceScore(a, now));
    const keepHot = ranked.slice(0, HOT_SET_SIZE);
    const goCold = ranked.slice(HOT_SET_SIZE);

    for (const f of keepHot) {
        if (f.cold === true) uncoldFact(f, db.category, 'COLD_REACTIVATED', 'rose back into hot set');
    }

    for (const f of goCold) {
        if (f.cold === true) continue; 
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

export function sinceIso(days) {
    return new Date(Date.now() - Math.max(0, days) * 86400000).toISOString();
}

export function upsertFact(db, fact) {

    const supersedesSignal = fact && fact.supersedes === true;
    if (fact && 'supersedes' in fact) { fact = { ...fact }; delete fact.supersedes; }

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

    if (existingIdx < 0 && normalizeKind(fact.kind) === 'state'
        && fact.kind !== undefined && fact.kind !== null && String(fact.kind).trim()) {
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

        const sal = mergeSalience(existing, fact);

        // History snapshots removed (v0.75): a changed fact now overwrites its live
        // record in place instead of leaving an inactive `_superseded` copy that no
        // read path ever surfaced. Any prior state worth keeping is carried forward
        // inside the fact's own note/value by the memory agent (see the prompt's
        // "UPDATING A CHANGED FACT" rule), so history stays visible to the storyteller.
        void supersedesSignal;

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

    const tone = normalizeTone(fact?.tone);
    if (tone) out.tone = tone;

    if (Number.isInteger(fact?.sceneNo) && fact.sceneNo >= 1) {
        out.sceneNo = fact.sceneNo;
        if (typeof fact?.sceneName === 'string' && fact.sceneName.trim()) out.sceneName = fact.sceneName.trim();
    }
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

    const incTone = normalizeTone(incoming?.tone);
    const exTone = normalizeTone(existing?.tone);
    if (incTone) out.tone = incTone;
    else if (exTone) out.tone = exTone;

    const exNo = Number.isInteger(existing?.sceneNo) ? existing.sceneNo : null;
    const incNo = Number.isInteger(incoming?.sceneNo) ? incoming.sceneNo : null;
    if (exNo !== null) {
        out.sceneNo = exNo;
        if (existing?.sceneName) out.sceneName = existing.sceneName;
    } else if (incNo !== null) {
        out.sceneNo = incNo;
        if (incoming?.sceneName) out.sceneName = incoming.sceneName;
    }
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
    const a = norm(matched.tags);
    const b = norm(fact.tags);
    return a.length !== b.length || a.some((t, i) => t !== b[i]); 
}

function normalizeFactKey(key) {
    let k = String(key || '').toLowerCase().trim();
    if (!k) return '';
    k = k.replace(/[_\-\s]+/g, '');      
    if (k.length > 3 && k.endsWith('s')) k = k.slice(0, -1); 
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

export function removeFact(db, key) {
    db.facts = db.facts.filter(f => f.key !== key);
    db.updatedAt = Date.now();
    return db;
}

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

export function getFactsByScene(databases, scene) {

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

    out.sort((a, b) => {
        const av = Number.isInteger(a.fact.validAt) ? a.fact.validAt : Number.MAX_SAFE_INTEGER;
        const bv = Number.isInteger(b.fact.validAt) ? b.fact.validAt : Number.MAX_SAFE_INTEGER;
        if (av !== bv) return av - bv;
        return String(a.fact.key).localeCompare(String(b.fact.key));
    });
    return out;
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
