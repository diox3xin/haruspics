/**
 * Inline Image Generation Extension for SillyTavern
 *
 * Catches [IMG:GEN:{json}] tags in AI messages and generates images via configured API.
 * Supports OpenAI-compatible and Gemini-compatible (nano-banana) endpoints.
 *
 * v3.0: Wardrobe system, 4-slot priority refs, Vision API descriptions,
 *       AbortController, request timeout, sequential generation, TreeWalker fix
 */

const MODULE_NAME = 'inline_image_gen';

const processingMessages = new Set();
const activeAbortControllers = new Map();

const logBuffer = [];
const MAX_LOG_ENTRIES = 200;

function iigLog(level, ...args) {
    const timestamp = new Date().toISOString();
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    const entry = `[${timestamp}] [${level}] ${message}`;
    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG_ENTRIES) logBuffer.shift();
    if (level === 'ERROR') console.error('[IIG]', ...args);
    else if (level === 'WARN') console.warn('[IIG]', ...args);
    else console.log('[IIG]', ...args);
}

function exportLogs() {
    const logsText = logBuffer.join('\n');
    const blob = new Blob([logsText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `iig-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toastr.success('Логи экспортированы', 'Генерация картинок');
}

// ============================================================
// DEFAULT SETTINGS
// ============================================================

const defaultSettings = Object.freeze({
    enabled: true,
    apiType: 'openai',
    endpoint: '',
    apiKey: '',
    model: '',
    size: '1024x1024',
    quality: 'standard',
    maxRetries: 0,
    retryDelay: 1000,
    requestTimeout: 120,
    sendCharAvatar: false,
    sendUserAvatar: false,
    userAvatarFile: '',
    autoDetectNames: true,
    defaultStyle: '',
    aspectRatio: '1:1',
    imageSize: '1K',
    npcReferences: [],
    wardrobeItems: [],
    activeWardrobeChar: null,
    activeWardrobeUser: null,
    injectWardrobeToChat: true,
    wardrobeInjectionDepth: 1,
    wardrobeDescEndpoint: '',
    wardrobeDescApiKey: '',
    wardrobeDescModel: '',
    wardrobeDescPrompt: 'Describe this clothing outfit in detail for a character in a roleplay. Focus on: type of garment, color, material/texture, style, notable features, accessories. Be concise but thorough (2-4 sentences). Write in English.',
    // ===== NEW: Presets =====
    apiPresets: [],
    activePresetId: null,
    // ===== NEW: Collapsed sections state =====
    collapsedSections: {},
});

// ============================================================
// MODEL DETECTION
// ============================================================

const IMAGE_MODEL_KEYWORDS = [
    'dall-e', 'midjourney', 'mj', 'journey', 'stable-diffusion', 'sdxl', 'flux',
    'imagen', 'drawing', 'paint', 'image', 'seedream', 'hidream', 'dreamshaper',
    'ideogram', 'nano-banana', 'gpt-image', 'wanx', 'qwen'
];

const VIDEO_MODEL_KEYWORDS = [
    'sora', 'kling', 'jimeng', 'veo', 'pika', 'runway', 'luma',
    'video', 'gen-3', 'minimax', 'cogvideo', 'mochi', 'seedance',
    'vidu', 'wan-ai', 'hunyuan', 'hailuo'
];

function isImageModel(modelId) {
    const mid = modelId.toLowerCase();
    for (const kw of VIDEO_MODEL_KEYWORDS) { if (mid.includes(kw)) return false; }
    if (mid.includes('vision') && mid.includes('preview')) return false;
    for (const kw of IMAGE_MODEL_KEYWORDS) { if (mid.includes(kw)) return true; }
    return false;
}

function isGeminiModel(modelId) {
    return modelId.toLowerCase().includes('nano-banana');
}

// ============================================================
// SETTINGS
// ============================================================

function getSettings() {
    const context = SillyTavern.getContext();
    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    const s = context.extensionSettings[MODULE_NAME];
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(s, key)) {
            s[key] = defaultSettings[key];
        }
    }
    // Migrate wardrobe items without description
    for (const item of (s.wardrobeItems || [])) {
        if (!Object.hasOwn(item, 'description')) item.description = '';
    }
    return s;
}

function saveSettings() {
    const context = SillyTavern.getContext();
    context.saveSettingsDebounced();
}

// ============================================================
// FETCH FUNCTIONS
// ============================================================

async function fetchModels() {
    const settings = getSettings();
    if (!settings.endpoint || !settings.apiKey) return [];
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1/models`;
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${settings.apiKey}` }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        return (data.data || []).filter(m => isImageModel(m.id)).map(m => m.id);
    } catch (error) {
        toastr.error(`Ошибка загрузки моделей: ${error.message}`, 'Генерация картинок');
        return [];
    }
}

async function fetchUserAvatars() {
    try {
        const context = SillyTavern.getContext();
        const response = await fetch('/api/avatars/get', {
            method: 'POST',
            headers: context.getRequestHeaders(),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } catch (error) {
        console.error('[IIG] Failed to fetch user avatars:', error);
        return [];
    }
}

async function fetchDescriptionModels() {
    const settings = getSettings();
    const endpoint = settings.wardrobeDescEndpoint || settings.endpoint;
    const apiKey = settings.wardrobeDescApiKey || settings.apiKey;
    if (!endpoint || !apiKey) return [];
    const url = `${endpoint.replace(/\/$/, '')}/v1/models`;
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        return (data.data || []).filter(m => !isImageModel(m.id)).map(m => m.id);
    } catch (error) {
        toastr.error(`Ошибка загрузки текстовых моделей: ${error.message}`, 'Генерация картинок');
        return [];
    }
}

// ============================================================
// IMAGE UTILITIES
// ============================================================

async function imageUrlToBase64(url) {
    try {
        const response = await fetch(url);
        const blob = await response.blob();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        console.error('[IIG] Failed to convert image to base64:', error);
        return null;
    }
}

async function resizeImageBase64(base64, maxSize = 512) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            let { width, height } = img;
            if (width <= maxSize && height <= maxSize) { resolve(base64); return; }
            const ratio = Math.min(maxSize / width, maxSize / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            canvas.getContext('2d').drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL('image/png').split(',')[1]);
        };
        img.onerror = () => resolve(base64);
        img.src = `data:image/png;base64,${base64}`;
    });
}

function detectMimeType(base64Data) {
    if (!base64Data || base64Data.length < 4) return 'image/png';
    if (base64Data.startsWith('/9j/')) return 'image/jpeg';
    if (base64Data.startsWith('iVBOR')) return 'image/png';
    if (base64Data.startsWith('UklGR')) return 'image/webp';
    if (base64Data.startsWith('R0lGOD')) return 'image/gif';
    return 'image/png';
}

// ============================================================
// FILE SAVE
// ============================================================

async function saveImageToFile(dataUrl) {
    const context = SillyTavern.getContext();

    if (dataUrl && !dataUrl.startsWith('data:') && (dataUrl.startsWith('http://') || dataUrl.startsWith('https://'))) {
        try {
            const response = await fetch(dataUrl);
            const blob = await response.blob();
            dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
        } catch (err) {
            throw new Error('Failed to download image from URL');
        }
    }

    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) throw new Error('Invalid data URL format');

    const format = match[1];
    const base64Data = match[2];

    let charName = 'generated';
    if (context.characterId !== undefined && context.characters?.[context.characterId]) {
        charName = context.characters[context.characterId].name || 'generated';
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `iig_${timestamp}`;

    const response = await fetch('/api/images/upload', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ image: base64Data, format, ch_name: charName, filename })
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error || `Upload failed: ${response.status}`);
    }

    const result = await response.json();
    return result.path;
}

// ============================================================
// AVATAR RETRIEVAL
// ============================================================

async function getCharacterAvatarBase64() {
    try {
        const context = SillyTavern.getContext();
        if (context.characterId === undefined || context.characterId === null) return null;
        if (typeof context.getCharacterAvatar === 'function') {
            const avatarUrl = context.getCharacterAvatar(context.characterId);
            if (avatarUrl) return await imageUrlToBase64(avatarUrl);
        }
        const character = context.characters?.[context.characterId];
        if (character?.avatar) {
            return await imageUrlToBase64(`/characters/${encodeURIComponent(character.avatar)}`);
        }
        return null;
    } catch (error) {
        console.error('[IIG] Error getting character avatar:', error);
        return null;
    }
}

async function getUserAvatarBase64() {
    try {
        const settings = getSettings();
        if (!settings.userAvatarFile) return null;
        return await imageUrlToBase64(`/User Avatars/${encodeURIComponent(settings.userAvatarFile)}`);
    } catch (error) {
        console.error('[IIG] Error getting user avatar:', error);
        return null;
    }
}

// ============================================================
// WARDROBE SYSTEM
// ============================================================

function addWardrobeItem(name, imageData, target = 'char') {
    const settings = getSettings();
    const item = {
        id: 'ward_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8),
        name: name || 'Outfit',
        imageData,
        description: '',
        target,
        createdAt: Date.now()
    };
    settings.wardrobeItems.push(item);
    saveSettings();
    return item;
}

function removeWardrobeItem(itemId) {
    const settings = getSettings();
    if (settings.activeWardrobeChar === itemId) settings.activeWardrobeChar = null;
    if (settings.activeWardrobeUser === itemId) settings.activeWardrobeUser = null;
    settings.wardrobeItems = settings.wardrobeItems.filter(i => i.id !== itemId);
    saveSettings();
    updateWardrobeInjection();
}

function setActiveWardrobe(itemId, target) {
    const settings = getSettings();
    const key = target === 'char' ? 'activeWardrobeChar' : 'activeWardrobeUser';
    settings[key] = settings[key] === itemId ? null : itemId;
    saveSettings();
    updateWardrobeInjection();
}

function getActiveWardrobeItem(target) {
    const settings = getSettings();
    const activeId = settings[target === 'char' ? 'activeWardrobeChar' : 'activeWardrobeUser'];
    return activeId ? (settings.wardrobeItems.find(i => i.id === activeId) || null) : null;
}

function updateWardrobeItemDescription(itemId, description) {
    const settings = getSettings();
    const item = settings.wardrobeItems.find(i => i.id === itemId);
    if (item) {
        item.description = description;
        saveSettings();
        updateWardrobeInjection();
    }
}

async function generateWardrobeDescription(itemId) {
    const settings = getSettings();
    const item = settings.wardrobeItems.find(i => i.id === itemId);
    if (!item?.imageData) throw new Error('Нет данных изображения');

    const endpoint = settings.wardrobeDescEndpoint || settings.endpoint;
    const apiKey = settings.wardrobeDescApiKey || settings.apiKey;
    const model = settings.wardrobeDescModel;
    if (!endpoint) throw new Error('Не настроен эндпоинт для генерации описаний');
    if (!apiKey) throw new Error('Не настроен API ключ');
    if (!model) throw new Error('Не выбрана модель для описаний');

    const promptText = settings.wardrobeDescPrompt || defaultSettings.wardrobeDescPrompt;

    const response = await fetch(`${endpoint.replace(/\/$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            max_tokens: 500,
            temperature: 0.3,
            messages: [{
                role: 'user',
                content: [
                    { type: 'image_url', image_url: { url: `data:image/png;base64,${item.imageData}` } },
                    { type: 'text', text: promptText }
                ]
            }],
        })
    });

    if (!response.ok) throw new Error(`API ошибка (${response.status}): ${await response.text().catch(() => '?')}`);
    const result = await response.json();
    const description = result.choices?.[0]?.message?.content?.trim();
    if (!description) throw new Error('Модель вернула пустой ответ');

    iigLog('INFO', `Generated wardrobe description for "${item.name}": ${description.substring(0, 100)}...`);
    return description;
}

function updateWardrobeInjection() {
    try {
        const context = SillyTavern.getContext();
        const settings = getSettings();
        const INJECTION_KEY = MODULE_NAME + '_wardrobe';

        if (!settings.injectWardrobeToChat) {
            if (typeof context.setExtensionPrompt === 'function') {
                context.setExtensionPrompt(INJECTION_KEY, '', 0, 0);
            }
            return;
        }

        const parts = [];

        const charItem = getActiveWardrobeItem('char');
        if (charItem?.description) {
            const charName = context.characters?.[context.characterId]?.name || 'Character';
            parts.push(`[${charName} is currently wearing: ${charItem.description}]`);
        }

        const userItem = getActiveWardrobeItem('user');
        if (userItem?.description) {
            const userName = context.name1 || 'User';
            parts.push(`[${userName} is currently wearing: ${userItem.description}]`);
        }

        const depth = settings.wardrobeInjectionDepth || 1;
        if (typeof context.setExtensionPrompt === 'function') {
            context.setExtensionPrompt(INJECTION_KEY, parts.join('\n'), 1, depth);
        }
    } catch (error) {
        iigLog('ERROR', 'Error updating wardrobe injection:', error);
    }
}

// ============================================================
// API PRESETS SYSTEM
// ============================================================

const PRESET_FIELDS = [
    'apiType', 'endpoint', 'apiKey', 'model',
    'size', 'quality', 'aspectRatio', 'imageSize'
];

function saveCurrentAsPreset(name) {
    const settings = getSettings();
    const preset = {
        id: 'preset_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
        name: name || 'Preset',
        createdAt: Date.now(),
    };
    for (const field of PRESET_FIELDS) {
        preset[field] = settings[field];
    }
    settings.apiPresets.push(preset);
    settings.activePresetId = preset.id;
    saveSettings();
    return preset;
}

function loadPreset(presetId) {
    const settings = getSettings();
    const preset = settings.apiPresets.find(p => p.id === presetId);
    if (!preset) return false;
    for (const field of PRESET_FIELDS) {
        if (Object.hasOwn(preset, field)) {
            settings[field] = preset[field];
        }
    }
    settings.activePresetId = presetId;
    saveSettings();
    return true;
}

function deletePreset(presetId) {
    const settings = getSettings();
    settings.apiPresets = settings.apiPresets.filter(p => p.id !== presetId);
    if (settings.activePresetId === presetId) settings.activePresetId = null;
    saveSettings();
}

function updatePresetFromCurrent(presetId) {
    const settings = getSettings();
    const preset = settings.apiPresets.find(p => p.id === presetId);
    if (!preset) return;
    for (const field of PRESET_FIELDS) {
        preset[field] = settings[field];
    }
    saveSettings();
}

function renderPresetSelect() {
    const settings = getSettings();
    const select = document.getElementById('iig_preset_select');
    if (!select) return;
    const currentVal = settings.activePresetId || '';
    select.innerHTML = '<option value="">-- без пресета --</option>';
    for (const p of settings.apiPresets) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        opt.selected = p.id === currentVal;
        select.appendChild(opt);
    }
}

// ============================================================
// COLLAPSIBLE SECTIONS
// ============================================================

function initCollapsibleSections() {
    const settings = getSettings();
    document.querySelectorAll('.iig-collapsible-header').forEach(header => {
        const section = header.closest('.iig-collapsible');
        if (!section) return;
        const sectionId = section.dataset.sectionId;

        // Restore saved state
        if (sectionId && settings.collapsedSections[sectionId]) {
            section.classList.add('collapsed');
        }

        header.addEventListener('click', () => {
            section.classList.toggle('collapsed');
            if (sectionId) {
                settings.collapsedSections[sectionId] = section.classList.contains('collapsed');
                saveSettings();
            }
        });
    });
}

// ============================================================
// NAME DETECTION
// ============================================================

function nameAppearsInPrompt(name, prompt) {
    if (!name || !prompt) return false;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'i');
    return regex.test(prompt);
}

// ============================================================
// 4-SLOT REFERENCE COLLECTOR
// ============================================================

const MAX_IMAGE_REFS = 4;

/**
 * Collects reference images with 4-slot priority system.
 * Priority: faces (char > user > NPCs) > clothing.
 * If clothing doesn't fit into 4 slots, it's returned as text-only.
 *
 * @param {string} prompt - Combined prompt text for name detection
 * @returns {{ imageRefs: Array, textOnlyClothing: Array, warnings: Array }}
 */
async function collectReferenceImages(prompt) {
    const settings = getSettings();
    const context = SillyTavern.getContext();

    const faceRefs = [];
    const clothingRefs = [];
    const textOnlyClothing = [];
    const warnings = [];

    const charName = context.characters?.[context.characterId]?.name || null;
    const userName = context.name1 || null;

    // ===== STEP 1: Collect face references (HIGHEST PRIORITY) =====

    const needCharAvatar = settings.sendCharAvatar ||
        (settings.autoDetectNames && charName && nameAppearsInPrompt(charName, prompt));

    if (needCharAvatar) {
        const charAvatar = await getCharacterAvatarBase64();
        if (charAvatar) {
            const resized = await resizeImageBase64(charAvatar, 768);
            faceRefs.push({
                data: resized,
                mimeType: detectMimeType(resized),
                name: charName || 'Character',
                type: 'face'
            });
            iigLog('INFO', `Face ref: "${charName}" added (${Math.round(resized.length / 1024)}KB)`);
        }
    }

    const needUserAvatar = settings.sendUserAvatar ||
        (settings.autoDetectNames && userName && nameAppearsInPrompt(userName, prompt));

    if (needUserAvatar) {
        const userAvatar = await getUserAvatarBase64();
        if (userAvatar) {
            const resized = await resizeImageBase64(userAvatar, 768);
            faceRefs.push({
                data: resized,
                mimeType: detectMimeType(resized),
                name: userName || 'User',
                type: 'face'
            });
            iigLog('INFO', `Face ref: "${userName}" added (${Math.round(resized.length / 1024)}KB)`);
        }
    }

    // NPC faces
    if (settings.npcReferences && settings.npcReferences.length > 0) {
        for (const npc of settings.npcReferences) {
            if (!npc.enabled || !npc.imageData || !npc.name) continue;
            if (nameAppearsInPrompt(npc.name, prompt)) {
                faceRefs.push({
                    data: npc.imageData,
                    mimeType: detectMimeType(npc.imageData),
                    name: npc.name,
                    type: 'face'
                });
                iigLog('INFO', `Face ref: NPC "${npc.name}" added (${Math.round(npc.imageData.length / 1024)}KB)`);
            }
        }
    }

    // ===== STEP 2: Collect clothing references =====

    const charWardrobeItem = getActiveWardrobeItem('char');
    if (charWardrobeItem?.imageData) {
        clothingRefs.push({
            data: charWardrobeItem.imageData,
            mimeType: detectMimeType(charWardrobeItem.imageData),
            name: charName || 'Character',
            outfitName: charWardrobeItem.name,
            description: charWardrobeItem.description || '',
            type: 'clothing'
        });
    }

    const userWardrobeItem = getActiveWardrobeItem('user');
    if (userWardrobeItem?.imageData) {
        clothingRefs.push({
            data: userWardrobeItem.imageData,
            mimeType: detectMimeType(userWardrobeItem.imageData),
            name: userName || 'User',
            outfitName: userWardrobeItem.name,
            description: userWardrobeItem.description || '',
            type: 'clothing'
        });
    }

    // ===== STEP 3: Apply 4-slot priority =====

    // If faces alone exceed the limit, trim them (char > user > NPCs in order)
    if (faceRefs.length > MAX_IMAGE_REFS) {
        const trimmed = faceRefs.length - MAX_IMAGE_REFS;
        const removed = faceRefs.splice(MAX_IMAGE_REFS);
        for (const r of removed) {
            iigLog('WARN', `Face ref "${r.name}" trimmed: exceeds ${MAX_IMAGE_REFS}-slot limit`);
        }
        warnings.push(`Слишком много лиц (${faceRefs.length + trimmed}). Последние ${trimmed} NPC не отправлены как рефы.`);
    }

    const freeSlots = Math.max(0, MAX_IMAGE_REFS - faceRefs.length);
    const clothingAsImage = clothingRefs.slice(0, freeSlots);
    const clothingAsTextOnly = clothingRefs.slice(freeSlots);

    // Process text-only clothing
    for (const c of clothingAsTextOnly) {
        if (c.description) {
            textOnlyClothing.push({
                charName: c.name,
                outfitName: c.outfitName,
                description: c.description
            });
            iigLog('INFO', `Clothing for "${c.name}" sent as TEXT (no image slot available): "${c.description.substring(0, 60)}..."`);
        } else {
            const warn = `Одежда "${c.outfitName}" для ${c.name} не отправлена: нет свободного слота и нет текстового описания.`;
            warnings.push(warn);
            iigLog('WARN', warn);
        }
    }

    // Final array: faces first, then clothing images
    const imageRefs = [...faceRefs, ...clothingAsImage];


// ============================================================
// IMAGE GENERATION: OpenAI
// ============================================================

async function generateImageOpenAI(prompt, style, refData, options = {}) {
    const settings = getSettings();
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1/images/generations`;

    const { imageRefs = [], textOnlyClothing = [] } = refData;

    // Build enhanced prompt
    const promptParts = [];

    if (style) promptParts.push(`[Style: ${style}]`);

    // Text-only clothing instructions
    for (const c of textOnlyClothing) {
        promptParts.push(`[CLOTHING: ${c.charName} is wearing: ${c.description}]`);
    }

    // Clothing from imageRefs that are clothing type
    for (const ref of imageRefs) {
        if (ref.type === 'clothing' && ref.description) {
            promptParts.push(`[CLOTHING for ${ref.name}: ${ref.description}]`);
        }
    }

    promptParts.push(prompt);

    const fullPrompt = promptParts.join('\n\n');

    let size = settings.size;
    if (options.aspectRatio) {
        if (options.aspectRatio === '16:9' || options.aspectRatio === '3:2') size = '1536x1024';
        else if (options.aspectRatio === '9:16' || options.aspectRatio === '2:3') size = '1024x1536';
        else if (options.aspectRatio === '1:1') size = '1024x1024';
        else size = 'auto';
    }

    const body = {
        model: settings.model,
        prompt: fullPrompt,
        n: 1,
        response_format: 'b64_json'
    };

    if (size && size !== 'auto') body.size = size;

    // Send reference images via body.image (gpt-image-1 compatible)
    if (imageRefs.length === 1) {
        body.image = `data:${imageRefs[0].mimeType};base64,${imageRefs[0].data}`;
    } else if (imageRefs.length > 1) {
        body.image = imageRefs.map(ref => `data:${ref.mimeType};base64,${ref.data}`);
    }

    iigLog('INFO', `OpenAI Request: model=${body.model}, size=${body.size || 'auto'}, refs=${imageRefs.length}, prompt=${fullPrompt.length} chars`);

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${settings.apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: options.signal
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`API Error (${response.status}): ${text}`);
    }

    const result = await response.json();
    const dataList = result.data || result.images || [];

    if (dataList.length === 0) {
        if (result.url) return result.url;
        if (result.image) return result.image.startsWith('data:') ? result.image : `data:image/png;base64,${result.image}`;
        if (result.b64_json) return `data:image/png;base64,${result.b64_json}`;
        throw new Error('No image data in response');
    }

    const imageObj = dataList[0];
    const b64Data = imageObj.b64_json || imageObj.b64 || imageObj.base64 || imageObj.image;
    const urlData = imageObj.url || imageObj.uri;

    if (b64Data) {
        if (b64Data.startsWith('data:')) return b64Data;
        let mimeType = 'image/png';
        if (b64Data.startsWith('/9j/')) mimeType = 'image/jpeg';
        else if (b64Data.startsWith('UklGR')) mimeType = 'image/webp';
        return `data:${mimeType};base64,${b64Data}`;
    }

    if (urlData) return urlData;
    throw new Error('Unexpected image response format');
}

// ============================================================
// IMAGE GENERATION: Gemini (nano-banana)
// ============================================================

const VALID_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const VALID_IMAGE_SIZES = ['1K', '2K', '4K'];

async function generateImageGemini(prompt, style, refData, options = {}) {
    const settings = getSettings();
    const model = settings.model;
    const baseUrl = settings.endpoint.replace(/\/$/, '');
    const isGoogleApi = baseUrl.includes('googleapis.com');

    const url = isGoogleApi
        ? `${baseUrl}/v1beta/models/${model}:generateContent?key=${settings.apiKey}`
        : `${baseUrl}/v1beta/models/${model}:generateContent`;

    let aspectRatio = options.aspectRatio || settings.aspectRatio || '1:1';
    if (!VALID_ASPECT_RATIOS.includes(aspectRatio)) aspectRatio = '1:1';
    let imageSize = options.imageSize || settings.imageSize || '1K';
    if (!VALID_IMAGE_SIZES.includes(imageSize)) imageSize = '1K';

    const { imageRefs = [], textOnlyClothing = [] } = refData;

    // Separate face and clothing refs
    const faceRefs = imageRefs.filter(r => r.type === 'face');
    const clothingImageRefs = imageRefs.filter(r => r.type === 'clothing');

    const parts = [];

    // ===== PRE-INSTRUCTION =====
    if (imageRefs.length > 0) {
        let preInstruction = `[CRITICAL INSTRUCTIONS FOR REFERENCE IMAGES]\n`;
        preInstruction += `You will receive ${imageRefs.length} reference image(s).\n`;
        preInstruction += `RULES:\n`;
        preInstruction += `1. FACE references have ABSOLUTE PRIORITY. Copy faces EXACTLY from face reference images.\n`;
        preInstruction += `2. CLOTHING references show ONLY the outfit design. Do NOT copy faces or body shapes from clothing images.\n`;
        preInstruction += `3. If a face in a clothing reference conflicts with a face reference, ALWAYS use the FACE reference.\n`;
        parts.push({ text: preInstruction });
    }

    // ===== FACE REFERENCES (HIGHEST PRIORITY, FIRST) =====
    let refCounter = 0;
    for (const ref of faceRefs) {
        refCounter++;
        parts.push({
            inlineData: { mimeType: ref.mimeType, data: ref.data }
        });
        parts.push({
            text: `[FACE REFERENCE #${refCounter}: "${ref.name}"]\n` +
                `This is the EXACT face and appearance of "${ref.name}".\n` +
                `COPY IDENTICALLY: face shape, eye shape & color, nose, mouth, jawline, hair color & style, skin tone.\n` +
                `Include ALL distinctive features (freckles, scars, moles, etc).\n` +
                `DO NOT modify, stylize, or "improve" this face. REPRODUCE IT EXACTLY AS SHOWN.\n`
        });
    }

    // ===== CLOTHING IMAGE REFERENCES (LOWER PRIORITY) =====
    for (const ref of clothingImageRefs) {
        refCounter++;
        parts.push({
            inlineData: { mimeType: ref.mimeType, data: ref.data }
        });
        let clothingLabel = `[CLOTHING-ONLY REFERENCE #${refCounter} for "${ref.name}": "${ref.outfitName || 'outfit'}"]\n`;
        clothingLabel += `⚠️ THIS IMAGE SHOWS ONLY CLOTHING/OUTFIT DESIGN.\n`;
        clothingLabel += `DO NOT copy any face, body shape, or person from this image.\n`;
        clothingLabel += `ONLY copy: garment type, fabric, colors, patterns, accessories, and overall style.\n`;
        clothingLabel += `"${ref.name}" MUST be wearing exactly this outfit.\n`;
        if (ref.description) {
            clothingLabel += `Outfit details: ${ref.description}\n`;
        }
        parts.push({ text: clothingLabel });
    }

    // ===== BUILD MAIN PROMPT =====
    let fullPrompt = '';

    // Character mapping
    if (imageRefs.length > 0) {
        fullPrompt += `[CHARACTER & CLOTHING MAPPING]\n`;
        let idx = 0;
        for (const ref of faceRefs) {
            idx++;
            fullPrompt += `• "${ref.name}" = Face Reference #${idx} (COPY FACE EXACTLY)\n`;
        }
        for (const ref of clothingImageRefs) {
            idx++;
            fullPrompt += `• "${ref.name}'s outfit" = Clothing Reference #${idx} (COPY GARMENT ONLY, NOT FACE)\n`;
        }
        fullPrompt += `\nCRITICAL: Face features must be IDENTICAL to face references. Clothing references affect ONLY what characters wear.\n\n`;
    }

    // Text-only clothing instructions
    if (textOnlyClothing.length > 0) {
        for (const c of textOnlyClothing) {
            fullPrompt += `[CLOTHING INSTRUCTION for "${c.charName}"]: ${c.charName} is wearing: ${c.description}\n\n`;
        }
    }

    // Style
    if (style) {
        fullPrompt += `[Art Style: ${style}]\n\n`;
    }

    // Main scene prompt
    fullPrompt += `[SCENE TO GENERATE]\n${prompt}\n[END SCENE]`;

    // Final reminder
    if (faceRefs.length > 0) {
        fullPrompt += `\n\n[FINAL REMINDER]\n`;
        fullPrompt += `The characters in this scene MUST look EXACTLY like their face reference images.\n`;
        fullPrompt += `Check each character's face against their reference before finalizing.\n`;
        if (clothingImageRefs.length > 0) {
            fullPrompt += `Clothing references affect ONLY the garments, NOT faces or body shapes.\n`;
        }
    }

    parts.push({ text: fullPrompt });

    iigLog('INFO', `Gemini request: ${faceRefs.length} face(s), ${clothingImageRefs.length} clothing img(s), ${textOnlyClothing.length} clothing text(s), prompt ${fullPrompt.length} chars`);

    const body = {
        contents: [{ role: 'user', parts }],
        generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: { aspectRatio, imageSize }
        }
    };

    const headers = { 'Content-Type': 'application/json' };
    if (!isGoogleApi) {
        headers['Authorization'] = `Bearer ${settings.apiKey}`;
    }

        // Safety: serialize body and check size
    let bodyString;
    try {
        bodyString = JSON.stringify(body);
    } catch (serializeError) {
        throw new Error(`Failed to serialize request body: ${serializeError.message}. Try reducing the number of reference images.`);
    }

    iigLog('INFO', `Gemini request body size: ${(bodyString.length / 1024 / 1024).toFixed(2)}MB`);


    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: bodyString,
        signal: options.signal
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`API Error (${response.status}): ${text}`);
    }

    const result = await response.json();
    const candidates = result.candidates || [];
    if (candidates.length === 0) throw new Error('No candidates in response');

    const responseParts = candidates[0].content?.parts || [];
    for (const part of responseParts) {
        if (part.inlineData) return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
        if (part.inline_data) return `data:${part.inline_data.mime_type};base64,${part.inline_data.data}`;
    }
    throw new Error('No image found in Gemini response');
}

// ============================================================
// GENERATION WITH RETRY
// ============================================================

function validateSettings() {
    const settings = getSettings();
    const errors = [];
    if (!settings.endpoint) errors.push('URL эндпоинта не настроен');
    if (!settings.apiKey) errors.push('API ключ не настроен');
    if (!settings.model) errors.push('Модель не выбрана');
    if (errors.length > 0) throw new Error(`Ошибка настроек: ${errors.join(', ')}`);
}

async function generateImageWithRetry(prompt, style, onStatusUpdate, options = {}) {
    validateSettings();
    const settings = getSettings();

    // Use pre-collected refData or collect now
    let refData = options.refData;
    if (!refData) {
        onStatusUpdate?.('Сбор референсов...');
        refData = await collectReferenceImages(prompt);
    }

    // Show warnings from ref collection
    if (refData.warnings?.length > 0) {
        for (const w of refData.warnings) {
            toastr.warning(w, 'Референсы', { timeOut: 6000 });
        }
    }

    const timeoutMs = (settings.requestTimeout || 120) * 1000;
    const externalSignal = options.signal;

    let lastError;
    for (let attempt = 0; attempt <= settings.maxRetries; attempt++) {
        const timeoutController = new AbortController();
        const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
        const onExternalAbort = () => timeoutController.abort();
        externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

        try {
            if (externalSignal?.aborted) throw new DOMException('Отменено пользователем', 'AbortError');

            onStatusUpdate?.(`Генерация${attempt > 0 ? ` (повтор ${attempt}/${settings.maxRetries})` : ''}...`);
            const genOptions = { ...options, signal: timeoutController.signal };

            if (settings.apiType === 'gemini' || isGeminiModel(settings.model)) {
                return await generateImageGemini(prompt, style, refData, genOptions);
            } else {
                return await generateImageOpenAI(prompt, style, refData, genOptions);
            }
        } catch (error) {
            lastError = error;
            if (error.name === 'AbortError') {
                lastError = externalSignal?.aborted
                    ? new Error('Отменено пользователем')
                    : new Error(`Таймаут: сервер не ответил за ${settings.requestTimeout}с`);
                break;
            }
            const isRetryable = /429|503|502|504|timeout|network/i.test(error.message);
            if (!isRetryable || attempt === settings.maxRetries) break;
            const delay = settings.retryDelay * Math.pow(2, attempt);
            onStatusUpdate?.(`Повтор через ${delay / 1000}с...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        } finally {
            clearTimeout(timeoutId);
            externalSignal?.removeEventListener('abort', onExternalAbort);
        }
    }
    throw lastError;
}

// ============================================================
// TAG PARSING
// ============================================================

async function checkFileExists(path) {
    try { return (await fetch(path, { method: 'HEAD' })).ok; } catch (e) { return false; }
}

const ERROR_IMAGE_PATH = '/scripts/extensions/third-party/sillyimages/error.svg';

async function parseImageTags(text, options = {}) {
    const { checkExistence = false, forceAll = false } = options;
    const tags = [];

    // NEW FORMAT: <img data-iig-instruction='...' src='...'>
    const imgTagMarker = 'data-iig-instruction=';
    let searchPos = 0;
    while (true) {
        const markerPos = text.indexOf(imgTagMarker, searchPos);
        if (markerPos === -1) break;
        let imgStart = text.lastIndexOf('<img', markerPos);
        if (imgStart === -1 || markerPos - imgStart > 500) { searchPos = markerPos + 1; continue; }
        const afterMarker = markerPos + imgTagMarker.length;
        let jsonStart = text.indexOf('{', afterMarker);
        if (jsonStart === -1 || jsonStart > afterMarker + 10) { searchPos = markerPos + 1; continue; }

        let braceCount = 0, jsonEnd = -1, inString = false, escapeNext = false;
        for (let i = jsonStart; i < text.length; i++) {
            const c = text[i];
            if (escapeNext) { escapeNext = false; continue; }
            if (c === '\\' && inString) { escapeNext = true; continue; }
            if (c === '"') { inString = !inString; continue; }
            if (!inString) {
                if (c === '{') braceCount++;
                else if (c === '}') { braceCount--; if (braceCount === 0) { jsonEnd = i + 1; break; } }
            }
        }
        if (jsonEnd === -1) { searchPos = markerPos + 1; continue; }
        let imgEnd = text.indexOf('>', jsonEnd);
        if (imgEnd === -1) { searchPos = markerPos + 1; continue; }
        imgEnd++;

        const fullImgTag = text.substring(imgStart, imgEnd);
        const instructionJson = text.substring(jsonStart, jsonEnd);
        const srcMatch = fullImgTag.match(/src\s*=\s*["']?([^"'\s>]+)/i);
        const srcValue = srcMatch ? srcMatch[1] : '';

        let needsGeneration = false;
        const hasMarker = srcValue.includes('[IMG:GEN]') || srcValue.includes('[IMG:');
        const hasErrorImage = srcValue.includes('error.svg');
        const hasPath = srcValue && srcValue.startsWith('/') && srcValue.length > 5;

        if (hasErrorImage && !forceAll) { searchPos = imgEnd; continue; }
        if (forceAll) needsGeneration = true;
        else if (hasMarker || !srcValue) needsGeneration = true;
        else if (hasPath && checkExistence) { if (!(await checkFileExists(srcValue))) needsGeneration = true; }
        else if (hasPath) { searchPos = imgEnd; continue; }

        if (!needsGeneration) { searchPos = imgEnd; continue; }

        try {
            let nj = instructionJson
                .replace(/"/g, '"').replace(/'/g, "'").replace(/'/g, "'")
                .replace(/"/g, '"').replace(/&/g, '&')
                .replace(/\u201c/g, '"').replace(/\u201d/g, '"')
                .replace(/\u2018/g, "'").replace(/\u2019/g, "'");
            const data = JSON.parse(nj);
            tags.push({
                fullMatch: fullImgTag, index: imgStart,
                style: data.style || '', prompt: data.prompt || '',
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null,
                isNewFormat: true, existingSrc: hasPath ? srcValue : null
            });
        } catch (e) {
            iigLog('WARN', `Failed to parse instruction JSON: ${e.message}`);
        }
        searchPos = imgEnd;
    }

    // LEGACY FORMAT: [IMG:GEN:{...}]
    const marker = '[IMG:GEN:';
    let searchStart = 0;
    while (true) {
        const markerIndex = text.indexOf(marker, searchStart);
        if (markerIndex === -1) break;
        const jsonStart = markerIndex + marker.length;
        let braceCount = 0, jsonEnd = -1, inString = false, escapeNext = false;
        for (let i = jsonStart; i < text.length; i++) {
            const c = text[i];
            if (escapeNext) { escapeNext = false; continue; }
            if (c === '\\' && inString) { escapeNext = true; continue; }
            if (c === '"') { inString = !inString; continue; }
            if (!inString) {
                if (c === '{') braceCount++;
                else if (c === '}') { braceCount--; if (braceCount === 0) { jsonEnd = i + 1; break; } }
            }
        }
        if (jsonEnd === -1) { searchStart = jsonStart; continue; }
        if (!text.substring(jsonEnd).startsWith(']')) { searchStart = jsonEnd; continue; }
        const tagOnly = text.substring(markerIndex, jsonEnd + 1);
        const jsonStr = text.substring(jsonStart, jsonEnd);
        try {
            let data;
            try {
                data = JSON.parse(jsonStr);
            } catch (_) {
                try {
                    data = JSON.parse(jsonStr.replace(/'/g, '"'));
                } catch (__) {
                    const relaxed = jsonStr
                        .replace(/(\w+)\s*:/g, '"$1":')
                        .replace(/:\s*'([^']*)'/g, ':"$1"');
                    data = JSON.parse(relaxed);
                }
            }
            tags.push({
                fullMatch: tagOnly, index: markerIndex,
                style: data.style || '', prompt: data.prompt || '',
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null,
                isNewFormat: false
            });
        } catch (e) {
            iigLog('WARN', `Failed to parse legacy tag: ${e.message}`);
        }
        searchStart = jsonEnd + 1;
    }

    return tags;
}

// ============================================================
// DOM HELPERS
// ============================================================

function createLoadingPlaceholder(tagId, onCancel) {
    const el = document.createElement('div');
    el.className = 'iig-loading-placeholder';
    el.dataset.tagId = tagId;
    el.style.cssText = 'position: relative; min-height: 80px;';
    el.innerHTML = `<div class="iig-spinner"></div><div class="iig-status">Генерация картинки...</div>`;

    if (onCancel) {
        const x = document.createElement('div');
        x.title = 'Отменить генерацию';
        x.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        x.style.cssText = 'position:absolute;top:4px;right:4px;width:22px;height:22px;display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:0.5;border-radius:50%;background:rgba(0,0,0,0.4);color:#fff;font-size:12px;z-index:1;';
        x.addEventListener('mouseenter', () => { x.style.opacity = '1'; });
        x.addEventListener('mouseleave', () => { x.style.opacity = '0.5'; });
        x.addEventListener('click', (e) => {
            e.stopPropagation();
            onCancel();
            x.style.pointerEvents = 'none';
            x.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            const statusEl = el.querySelector('.iig-status');
            if (statusEl) statusEl.textContent = 'Отмена...';
        });
        el.appendChild(x);
    }

    return el;
}

function createErrorPlaceholder(tagId, errorMessage, tagInfo) {
    const img = document.createElement('img');
    img.className = 'iig-error-image';
    img.src = ERROR_IMAGE_PATH;
    img.alt = 'Ошибка генерации';
    img.title = `Ошибка: ${errorMessage}`;
    img.dataset.tagId = tagId;
    if (tagInfo.fullMatch) {
        const m = tagInfo.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
        if (m) img.setAttribute('data-iig-instruction', m[2]);
    }
    return img;
}

function wrapImageWithRegen(img, messageId, tagIndex) {
    const wrapper = document.createElement('div');
    wrapper.className = 'iig-image-wrapper';
    wrapper.style.cssText = 'position:relative;display:inline-block;';

    const regenBtn = document.createElement('div');
    regenBtn.title = 'Перегенерировать эту картинку';
    regenBtn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i>';
    regenBtn.style.cssText = 'position:absolute;top:4px;right:4px;width:26px;height:26px;display:none;align-items:center;justify-content:center;cursor:pointer;border-radius:50%;background:rgba(0,0,0,0.5);color:#fff;font-size:13px;z-index:1;';
    regenBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await regenerateSingleImage(messageId, tagIndex);
    });

    wrapper.addEventListener('mouseenter', () => { regenBtn.style.display = 'flex'; });
    wrapper.addEventListener('mouseleave', () => { regenBtn.style.display = 'none'; });

    wrapper.appendChild(regenBtn);
    wrapper.appendChild(img);
    return wrapper;
}

// ============================================================
// MESSAGE PROCESSING
// ============================================================

async function processMessageTags(messageId) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    if (!settings.enabled) return;
    if (processingMessages.has(messageId)) return;

    const message = context.chat[messageId];
    if (!message || message.is_user) return;

    const tags = await parseImageTags(message.mes, { checkExistence: true });
    if (tags.length === 0) return;

    processingMessages.add(messageId);
    toastr.info(`Найдено тегов: ${tags.length}. Генерация...`, 'Генерация картинок', { timeOut: 3000 });

    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) { processingMessages.delete(messageId); return; }
    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) { processingMessages.delete(messageId); return; }

    const abortController = new AbortController();
    activeAbortControllers.set(messageId, abortController);

    // Collect references ONCE using all prompts
    const allPrompts = tags.map(t => t.prompt).join(' ');
    let sharedRefData;
    try {
        sharedRefData = await collectReferenceImages(allPrompts);
    } catch (e) {
        sharedRefData = { imageRefs: [], textOnlyClothing: [], warnings: [] };
        iigLog('WARN', 'Failed to collect references:', e.message);
    }

    // Prepare legacy tag placeholders via TreeWalker (DOM-safe)
    for (let i = 0; i < tags.length; i++) {
        const tag = tags[i];
        if (!tag.isNewFormat) {
            const walker = document.createTreeWalker(mesTextEl, NodeFilter.SHOW_TEXT, null);
            let textNode;
            while ((textNode = walker.nextNode())) {
                const pos = textNode.textContent.indexOf(tag.fullMatch);
                if (pos !== -1) {
                    const beforeText = textNode.textContent.substring(0, pos);
                    const afterText = textNode.textContent.substring(pos + tag.fullMatch.length);
                    const placeholder = document.createElement('span');
                    placeholder.dataset.iigPlaceholder = `iig-${messageId}-${i}`;
                    const parent = textNode.parentNode;
                    if (beforeText) parent.insertBefore(document.createTextNode(beforeText), textNode);
                    parent.insertBefore(placeholder, textNode);
                    if (afterText) parent.insertBefore(document.createTextNode(afterText), textNode);
                    parent.removeChild(textNode);
                    tag._placeholderEl = placeholder;
                    break;
                }
            }
        }
    }

    // Sequential generation
    for (let index = 0; index < tags.length; index++) {
        if (abortController.signal.aborted) break;

        const tag = tags[index];
        const tagId = `iig-${messageId}-${index}`;

        // Combine default style with tag style
        let tagStyle = tag.style || '';
        if (settings.defaultStyle) {
            tagStyle = settings.defaultStyle + (tagStyle ? ', ' + tagStyle : '');
        }

        const loadingPlaceholder = createLoadingPlaceholder(tagId, () => abortController.abort());

        let targetElement = null;

        if (tag.isNewFormat) {
            const allImgs = mesTextEl.querySelectorAll('img[data-iig-instruction]');
            const searchPrompt = tag.prompt.substring(0, 30);

            for (const img of allImgs) {
                const instr = img.getAttribute('data-iig-instruction');
                if (!instr) continue;
                const decoded = instr.replace(/"/g, '"').replace(/'/g, "'")
                    .replace(/'/g, "'").replace(/"/g, '"').replace(/&/g, '&');
                if (decoded.includes(searchPrompt)) { targetElement = img; break; }
                try {
                    const d = JSON.parse(decoded.replace(/'/g, '"'));
                    if (d.prompt?.substring(0, 30) === tag.prompt.substring(0, 30)) { targetElement = img; break; }
                } catch (_) {}
                if (instr.includes(searchPrompt)) { targetElement = img; break; }
            }

            if (!targetElement) {
                for (const img of allImgs) {
                    const src = img.getAttribute('src') || '';
                    if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]') || src === '' || src === '#') {
                        targetElement = img; break;
                    }
                }
            }

            if (!targetElement) {
                for (const img of mesTextEl.querySelectorAll('img')) {
                    const src = img.getAttribute('src') || '';
                    if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]')) {
                        targetElement = img; break;
                    }
                }
            }
        } else {
            targetElement = tag._placeholderEl || null;
        }

        if (targetElement) targetElement.replaceWith(loadingPlaceholder);
        else mesTextEl.appendChild(loadingPlaceholder);

        const statusEl = loadingPlaceholder.querySelector('.iig-status');

        try {
            const dataUrl = await generateImageWithRetry(
                tag.prompt, tagStyle,
                (s) => { if (statusEl) statusEl.textContent = s; },
                {
                    aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality,
                    refData: sharedRefData,
                    signal: abortController.signal
                }
            );

            if (statusEl) statusEl.textContent = 'Сохранение...';
            const imagePath = await saveImageToFile(dataUrl);

            const img = document.createElement('img');
            img.className = 'iig-generated-image';
            img.src = imagePath;
            img.alt = tag.prompt;
            img.title = `Style: ${tagStyle}\nPrompt: ${tag.prompt}`;

            if (tag.isNewFormat) {
                const instrMatch = tag.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
                if (instrMatch) img.setAttribute('data-iig-instruction', instrMatch[2]);
            }

            const wrapped = wrapImageWithRegen(img, messageId, index);
            loadingPlaceholder.replaceWith(wrapped);

            if (tag.isNewFormat) {
                const updatedTag = tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`);
                message.mes = message.mes.replace(tag.fullMatch, updatedTag);
            } else {
                message.mes = message.mes.replace(tag.fullMatch, `[IMG:✓:${imagePath}]`);
            }

            toastr.success(`Картинка ${index + 1}/${tags.length} готова`, 'Генерация картинок', { timeOut: 2000 });
        } catch (error) {
            iigLog('ERROR', `Failed to generate image for tag ${index}:`, error.message);

            const errorPlaceholder = createErrorPlaceholder(tagId, error.message, tag);
            loadingPlaceholder.replaceWith(errorPlaceholder);

            if (tag.isNewFormat) {
                const errorTag = tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${ERROR_IMAGE_PATH}"`);
                message.mes = message.mes.replace(tag.fullMatch, errorTag);
            } else {
                message.mes = message.mes.replace(tag.fullMatch, `[IMG:ERROR:${error.message.substring(0, 50)}]`);
            }

            if (abortController.signal.aborted) {
                toastr.warning('Генерация отменена', 'Генерация картинок');
                break;
            }
            toastr.error(`Ошибка генерации: ${error.message}`, 'Генерация картинок');
        }
    }

    processingMessages.delete(messageId);
    activeAbortControllers.delete(messageId);
    await context.saveChat();

    if (typeof context.messageFormatting === 'function') {
        mesTextEl.innerHTML = context.messageFormatting(message.mes, message.name, message.is_system, message.is_user, messageId);
    }
}

// ============================================================
// SINGLE IMAGE REGENERATION
// ============================================================

async function regenerateSingleImage(messageId, tagIndex) {
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];
    if (!message) { toastr.error('Сообщение не найдено'); return; }

    const tags = await parseImageTags(message.mes, { forceAll: true });
    if (!tags[tagIndex]) { toastr.error('Тег не найден'); return; }
    const tag = tags[tagIndex];

    const settings = getSettings();
    let tagStyle = tag.style || '';
    if (settings.defaultStyle) {
        tagStyle = settings.defaultStyle + (tagStyle ? ', ' + tagStyle : '');
    }

    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) return;
    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) return;

    const allWrappers = Array.from(mesTextEl.querySelectorAll('.iig-image-wrapper'));
    const allImgs = Array.from(mesTextEl.querySelectorAll('img.iig-generated-image, img.iig-error-image, img[data-iig-instruction]'));
    const targetEl = allWrappers[tagIndex] || allImgs[tagIndex];
    if (!targetEl) { toastr.error('Картинка не найдена в DOM'); return; }

    const abortController = new AbortController();
    const lp = createLoadingPlaceholder(`iig-single-${messageId}-${tagIndex}`, () => abortController.abort());
    targetEl.replaceWith(lp);
    const statusEl = lp.querySelector('.iig-status');

    let refData;
    try { refData = await collectReferenceImages(tag.prompt); } catch (_) {
        refData = { imageRefs: [], textOnlyClothing: [], warnings: [] };
    }

    try {
        const dataUrl = await generateImageWithRetry(
            tag.prompt, tagStyle,
            (s) => { if (statusEl) statusEl.textContent = s; },
            { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality, refData, signal: abortController.signal }
        );
        if (statusEl) statusEl.textContent = 'Сохранение...';
        const imagePath = await saveImageToFile(dataUrl);

        const img = document.createElement('img');
        img.className = 'iig-generated-image';
        img.src = imagePath;
        img.alt = tag.prompt;
        const instrMatch = tag.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
        if (instrMatch) img.setAttribute('data-iig-instruction', instrMatch[2]);

        const wrapped = wrapImageWithRegen(img, messageId, tagIndex);
        lp.replaceWith(wrapped);

        message.mes = message.mes.replace(tag.fullMatch, tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`));
        await context.saveChat();
        toastr.success('Картинка перегенерирована', 'Генерация картинок', { timeOut: 2000 });
    } catch (error) {
        iigLog('ERROR', `Single regen failed: ${error.message}`);
        lp.replaceWith(createErrorPlaceholder(`iig-single-${messageId}-${tagIndex}`, error.message, tag));
        if (abortController.signal.aborted) toastr.warning('Генерация отменена');
        else toastr.error(`Ошибка: ${error.message}`);
    }
}

// ============================================================
// MESSAGE REGENERATION (ALL IMAGES)
// ============================================================

async function regenerateMessageImages(messageId) {
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];
    if (!message) { toastr.error('Сообщение не найдено'); return; }

    const tags = await parseImageTags(message.mes, { forceAll: true });
    if (tags.length === 0) { toastr.warning('Нет тегов для перегенерации'); return; }

    const settings = getSettings();

    processingMessages.add(messageId);
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) { processingMessages.delete(messageId); return; }
    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) { processingMessages.delete(messageId); return; }

    const abortController = new AbortController();
    activeAbortControllers.set(messageId, abortController);

    // Shared references
    const allPrompts = tags.map(t => t.prompt).join(' ');
    let sharedRefData;
    try { sharedRefData = await collectReferenceImages(allPrompts); } catch (e) {
        sharedRefData = { imageRefs: [], textOnlyClothing: [], warnings: [] };
    }

    const allWrappers = Array.from(mesTextEl.querySelectorAll('.iig-image-wrapper'));
    const allBareImgs = Array.from(mesTextEl.querySelectorAll('img[data-iig-instruction], img.iig-generated-image, img.iig-error-image'));
    const targetPool = allWrappers.length >= tags.length ? allWrappers :
        allWrappers.length > 0 ? allWrappers : allBareImgs;

    for (let index = 0; index < tags.length; index++) {
        if (abortController.signal.aborted) break;

        const tag = tags[index];
        let tagStyle = tag.style || '';
        if (settings.defaultStyle) {
            tagStyle = settings.defaultStyle + (tagStyle ? ', ' + tagStyle : '');
        }

        const targetEl = targetPool[index] || null;
        if (!targetEl) { iigLog('WARN', `No matching element for tag ${index}`); continue; }

        const innerImg = targetEl.querySelector?.('img[data-iig-instruction]') || targetEl;

        try {
            const instruction = innerImg.getAttribute?.('data-iig-instruction');
            const lp = createLoadingPlaceholder(`iig-regen-${messageId}-${index}`, () => abortController.abort());
            targetEl.replaceWith(lp);
            const statusEl = lp.querySelector('.iig-status');

            const dataUrl = await generateImageWithRetry(
                tag.prompt, tagStyle,
                (s) => { if (statusEl) statusEl.textContent = s; },
                { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality, refData: sharedRefData, signal: abortController.signal }
            );

            if (statusEl) statusEl.textContent = 'Сохранение...';
            const imagePath = await saveImageToFile(dataUrl);

            const img = document.createElement('img');
            img.className = 'iig-generated-image';
            img.src = imagePath;
            img.alt = tag.prompt;
            if (instruction) img.setAttribute('data-iig-instruction', instruction);

            const wrapped = wrapImageWithRegen(img, messageId, index);
            lp.replaceWith(wrapped);

            message.mes = message.mes.replace(tag.fullMatch, tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`));
            toastr.success(`Картинка ${index + 1}/${tags.length} готова`, 'Генерация картинок', { timeOut: 2000 });
        } catch (error) {
            iigLog('ERROR', `Regen failed for tag ${index}: ${error.message}`);
            if (abortController.signal.aborted) { toastr.warning('Перегенерация отменена'); break; }
            toastr.error(`Ошибка: ${error.message}`);
        }
    }

    processingMessages.delete(messageId);
    activeAbortControllers.delete(messageId);
    await context.saveChat();
}

// ============================================================
// REGEN BUTTONS ON MESSAGES
// ============================================================

function addRegenerateButton(messageElement, messageId) {
    if (messageElement.querySelector('.iig-regenerate-btn')) return;
    const extra = messageElement.querySelector('.extraMesButtons');
    if (!extra) return;
    const btn = document.createElement('div');
    btn.className = 'mes_button iig-regenerate-btn fa-solid fa-images interactable';
    btn.title = 'Перегенерировать картинки';
    btn.tabIndex = 0;
    btn.addEventListener('click', async (e) => { e.stopPropagation(); await regenerateMessageImages(messageId); });
    extra.appendChild(btn);
}

function addButtonsToExistingMessages() {
    const context = SillyTavern.getContext();
    if (!context.chat?.length) return;
    for (const el of document.querySelectorAll('#chat .mes')) {
        const mesId = el.getAttribute('mesid');
        if (mesId === null) continue;
        const mid = parseInt(mesId, 10);
        const msg = context.chat[mid];
        if (msg && !msg.is_user) addRegenerateButton(el, mid);
    }
}

async function onMessageReceived(messageId) {
    const settings = getSettings();
    if (!settings.enabled) return;
    const el = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!el) return;
    addRegenerateButton(el, messageId);
    await processMessageTags(messageId);
}

// ============================================================
// UI: NPC LIST
// ============================================================

function renderNpcList() {
    const settings = getSettings();
    const container = document.getElementById('iig_npc_list');
    if (!container) return;
    container.innerHTML = '';

    if (!settings.npcReferences || settings.npcReferences.length === 0) {
        container.innerHTML = '<p style="color:#5a5252;font-size:11px;">Нет добавленных NPC</p>';
        return;
    }

    for (let i = 0; i < settings.npcReferences.length; i++) {
        const npc = settings.npcReferences[i];
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px;';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = npc.enabled !== false;
        checkbox.addEventListener('change', (e) => {
            settings.npcReferences[i].enabled = e.target.checked;
            saveSettings();
        });

        const preview = document.createElement('div');
        preview.style.cssText = 'width:32px;height:32px;border-radius:6px;overflow:hidden;flex-shrink:0;';
        if (npc.imageData) {
            const img = document.createElement('img');
            img.src = `data:image/jpeg;base64,${npc.imageData}`;
            img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
            preview.appendChild(img);
        } else {
            preview.style.cssText += 'background:#2a2a2a;display:flex;align-items:center;justify-content:center;';
            preview.innerHTML = '<i class="fa-solid fa-user" style="color:#5a5252;font-size:14px;"></i>';
        }

        const nameSpan = document.createElement('span');
        nameSpan.textContent = npc.name;
        nameSpan.style.cssText = 'flex:1;color:#e8e0e0;font-size:12px;';

        const uploadBtn = document.createElement('div');
        uploadBtn.className = 'menu_button';
        uploadBtn.title = 'Загрузить картинку';
        uploadBtn.innerHTML = '<i class="fa-solid fa-upload"></i>';
        uploadBtn.addEventListener('click', () => {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = 'image/*';
            fileInput.addEventListener('change', async (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = async (ev) => {
                    const rawBase64 = ev.target.result.split(',')[1];
                    try {
                        const resized = await resizeImageBase64(rawBase64, 768);
                        settings.npcReferences[i].imageData = resized;
                        saveSettings();
                        renderNpcList();
                        toastr.success(`Картинка для ${npc.name} загружена`, 'NPC');
                    } catch (err) {
                        toastr.error('Ошибка сжатия картинки', 'NPC');
                    }
                };
                reader.readAsDataURL(file);
            });
            fileInput.click();
        });

        const deleteBtn = document.createElement('div');
        deleteBtn.className = 'menu_button';
        deleteBtn.title = 'Удалить NPC';
        deleteBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
        deleteBtn.style.color = '#cc5555';
        deleteBtn.addEventListener('click', () => {
            settings.npcReferences.splice(i, 1);
            saveSettings();
            renderNpcList();
            toastr.info(`NPC "${npc.name}" удалён`, 'NPC');
        });

        row.appendChild(checkbox);
        row.appendChild(preview);
        row.appendChild(nameSpan);
        row.appendChild(uploadBtn);
        row.appendChild(deleteBtn);
        container.appendChild(row);
    }
}

// ============================================================
// UI: WARDROBE GRID & DESCRIPTION PANEL
// ============================================================

function renderWardrobeGrid(target) {
    const settings = getSettings();
    const containerId = `iig_wardrobe_${target}`;
    const container = document.getElementById(containerId);
    if (!container) return;

    const items = settings.wardrobeItems.filter(i => i.target === target);
    const activeId = settings[target === 'char' ? 'activeWardrobeChar' : 'activeWardrobeUser'];

    if (items.length === 0) {
        container.innerHTML = '<div style="color:#5a5252;font-size:11px;padding:8px 0;">Нет одежды. Нажмите + чтобы добавить.</div>';
        renderWardrobeDescriptionPanel(target);
        return;
    }

    container.innerHTML = '';
    container.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin:6px 0;';

    for (const item of items) {
        const isActive = item.id === activeId;

        const card = document.createElement('div');
        card.style.cssText = `position:relative;width:80px;height:100px;border-radius:8px;overflow:hidden;cursor:pointer;border:2px solid ${isActive ? '#ffb6c1' : 'rgba(255,255,255,0.08)'};transition:border-color 0.2s;`;

        const img = document.createElement('img');
        img.src = `data:image/png;base64,${item.imageData}`;
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
        card.appendChild(img);

        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:absolute;bottom:0;left:0;right:0;background:linear-gradient(transparent,rgba(0,0,0,0.8));padding:3px 5px;';

        const nameEl = document.createElement('span');
        nameEl.textContent = item.name;
        nameEl.style.cssText = 'font-size:9px;color:#fff;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        nameEl.title = item.name;
        overlay.appendChild(nameEl);

        if (item.description) {
            const descIcon = document.createElement('i');
            descIcon.className = 'fa-solid fa-file-lines';
            descIcon.style.cssText = 'font-size:8px;color:#aaf;position:absolute;top:3px;left:3px;';
            descIcon.title = 'Есть описание';
            card.appendChild(descIcon);
        }

        card.appendChild(overlay);

        if (isActive) {
            const check = document.createElement('div');
            check.style.cssText = 'position:absolute;top:3px;right:3px;width:18px;height:18px;border-radius:50%;background:#ffb6c1;display:flex;align-items:center;justify-content:center;';
            check.innerHTML = '<i class="fa-solid fa-check" style="font-size:10px;color:#000;"></i>';
            card.appendChild(check);
        }

        const deleteBtn = document.createElement('div');
        deleteBtn.style.cssText = 'position:absolute;bottom:18px;right:3px;width:18px;height:18px;border-radius:50%;background:rgba(200,50,50,0.8);display:none;align-items:center;justify-content:center;cursor:pointer;';
        deleteBtn.innerHTML = '<i class="fa-solid fa-trash" style="font-size:8px;color:#fff;"></i>';
        deleteBtn.title = 'Удалить';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeWardrobeItem(item.id);
            renderWardrobeGrid(target);
            toastr.info('Одежда удалена');
        });
        card.appendChild(deleteBtn);

        card.addEventListener('mouseenter', () => { deleteBtn.style.display = 'flex'; });
        card.addEventListener('mouseleave', () => { deleteBtn.style.display = 'none'; });

        card.addEventListener('click', () => {
            setActiveWardrobe(item.id, target);
            renderWardrobeGrid(target);
        });

        container.appendChild(card);
    }

    renderWardrobeDescriptionPanel(target);
}

function renderWardrobeDescriptionPanel(target) {
    const panelId = `iig_wardrobe_desc_${target}`;
    let panel = document.getElementById(panelId);

    if (!panel) {
        const grid = document.getElementById(`iig_wardrobe_${target}`);
        if (!grid) return;
        panel = document.createElement('div');
        panel.id = panelId;
        grid.parentNode.insertBefore(panel, grid.nextSibling);
    }

    const activeItem = getActiveWardrobeItem(target);
    if (!activeItem) {
        panel.innerHTML = '';
        panel.style.display = 'none';
        return;
    }

    panel.style.display = 'block';
    panel.style.cssText = 'margin:8px 0;padding:8px;border:1px solid rgba(255,182,193,0.15);border-radius:8px;background:rgba(255,182,193,0.03);';
    panel.innerHTML = `
        <div style="font-size:11px;color:#e8e0e0;margin-bottom:4px;">
            <i class="fa-solid fa-shirt" style="margin-right:4px;"></i>
            Описание: <b>${activeItem.name}</b>
        </div>
        <textarea class="text_pole" rows="3" style="width:100%;font-size:11px;resize:vertical;"
            placeholder="Введите описание одежды вручную или сгенерируйте через AI..."
            data-wardrobe-id="${activeItem.id}">${activeItem.description || ''}</textarea>
        <div style="display:flex;gap:6px;margin-top:4px;">
            <div class="menu_button iig-ward-desc-generate" data-wardrobe-id="${activeItem.id}" style="flex:1;font-size:11px;">
                <i class="fa-solid fa-robot"></i> Сгенерировать
            </div>
            <div class="menu_button iig-ward-desc-save" data-wardrobe-id="${activeItem.id}" style="font-size:11px;">
                <i class="fa-solid fa-floppy-disk"></i> Сохранить
            </div>
            <div class="menu_button iig-ward-desc-clear" data-wardrobe-id="${activeItem.id}" style="font-size:11px;">
                <i class="fa-solid fa-eraser"></i>
            </div>
        </div>
        <div id="iig_ward_desc_status_${target}" style="display:none;font-size:10px;margin-top:4px;"></div>
    `;

    const textarea = panel.querySelector('textarea');

    textarea?.addEventListener('blur', () => {
        updateWardrobeItemDescription(textarea.dataset.wardrobeId, textarea.value);
    });

    panel.querySelector('.iig-ward-desc-save')?.addEventListener('click', () => {
        updateWardrobeItemDescription(textarea.dataset.wardrobeId, textarea.value);
        toastr.success('Описание сохранено');
        renderWardrobeGrid(target);
    });

    panel.querySelector('.iig-ward-desc-clear')?.addEventListener('click', () => {
        textarea.value = '';
        updateWardrobeItemDescription(textarea.dataset.wardrobeId, '');
        toastr.info('Описание очищено');
        renderWardrobeGrid(target);
    });

    panel.querySelector('.iig-ward-desc-generate')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const itemId = btn.dataset.wardrobeId;
        const statusEl = document.getElementById(`iig_ward_desc_status_${target}`);

        btn.classList.add('disabled');
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Генерация...';
        if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = 'Отправка картинки vision-модели...'; statusEl.style.color = '#aaa'; }

        try {
            const desc = await generateWardrobeDescription(itemId);
            textarea.value = desc;
            updateWardrobeItemDescription(itemId, desc);
            if (statusEl) { statusEl.textContent = 'Описание сгенерировано!'; statusEl.style.color = '#8f8'; }
            toastr.success('Описание сгенерировано через AI');
            renderWardrobeGrid(target);
        } catch (error) {
            iigLog('ERROR', 'Failed to generate wardrobe description:', error);
            if (statusEl) { statusEl.textContent = `Ошибка: ${error.message}`; statusEl.style.color = '#f88'; }
            toastr.error(`Ошибка: ${error.message}`);
        } finally {
            btn.classList.remove('disabled');
            btn.innerHTML = '<i class="fa-solid fa-robot"></i> Сгенерировать';
            setTimeout(() => { if (statusEl) statusEl.style.display = 'none'; }, 5000);
        }
    });
}

// ============================================================
// UI: AVATAR DROPDOWN
// ============================================================

function renderAvatarDropdown(avatars = []) {
    const settings = getSettings();
    const list = document.getElementById('iig_avatar_dropdown_list');
    if (!list) return;
    list.innerHTML = '';

    const emptyItem = document.createElement('div');
    emptyItem.className = `iig-avatar-dropdown-item iig-no-avatar ${!settings.userAvatarFile ? 'selected' : ''}`;
    emptyItem.dataset.value = '';
    emptyItem.innerHTML = `
        <div style="width:36px;height:36px;border-radius:5px;background:rgba(255,255,255,0.03);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
            <i class="fa-solid fa-ban" style="color:#5a5252;font-size:12px;"></i>
        </div>
        <span class="iig-item-name">-- Не выбран --</span>
    `;
    emptyItem.addEventListener('click', () => selectAvatar('', null));
    list.appendChild(emptyItem);

    for (const avatarFile of avatars) {
        const item = document.createElement('div');
        item.className = `iig-avatar-dropdown-item ${settings.userAvatarFile === avatarFile ? 'selected' : ''}`;
        item.dataset.value = avatarFile;

        const thumb = document.createElement('img');
        thumb.className = 'iig-item-thumb';
        thumb.src = `/User Avatars/${encodeURIComponent(avatarFile)}`;
        thumb.alt = avatarFile;
        thumb.loading = 'lazy';
        thumb.onerror = function () { this.style.display = 'none'; };

        const name = document.createElement('span');
        name.className = 'iig-item-name';
        name.textContent = avatarFile;

        item.appendChild(thumb);
        item.appendChild(name);
        item.addEventListener('click', () => selectAvatar(avatarFile, thumb.src));
        list.appendChild(item);
    }
}

async function loadAndRenderAvatars() {
    try {
        const avatars = await fetchUserAvatars();
        renderAvatarDropdown(avatars);
    } catch (error) {
        iigLog('ERROR', 'Failed to load avatars:', error.message);
    }
}

function selectAvatar(avatarFile) {
    const settings = getSettings();
    settings.userAvatarFile = avatarFile;
    saveSettings();

    const selected = document.getElementById('iig_avatar_dropdown_selected');
    if (selected) {
        if (avatarFile) {
            selected.innerHTML = `
                <img class="iig-dropdown-thumb" src="/User Avatars/${encodeURIComponent(avatarFile)}" alt="" onerror="this.style.display='none'">
                <span class="iig-dropdown-text">${avatarFile}</span>
                <span class="iig-dropdown-arrow fa-solid fa-chevron-down"></span>
            `;
        } else {
            selected.innerHTML = `
                <div class="iig-dropdown-placeholder"><i class="fa-solid fa-user"></i></div>
                <span class="iig-dropdown-text">-- Не выбран --</span>
                <span class="iig-dropdown-arrow fa-solid fa-chevron-down"></span>
            `;
        }
    }

    const list = document.getElementById('iig_avatar_dropdown_list');
    if (list) {
        list.querySelectorAll('.iig-avatar-dropdown-item').forEach(item => {
            item.classList.toggle('selected', item.dataset.value === avatarFile);
        });
    }

    const dropdown = document.getElementById('iig_avatar_dropdown');
    if (dropdown) dropdown.classList.remove('open');
}

function updateCharAvatarPreview() {
    const context = SillyTavern.getContext();
    const preview = document.getElementById('iig-char-avatar-preview');
    if (!preview) return;
    const character = context.characters?.[context.characterId];
    if (character?.avatar) {
        const img = preview.querySelector('img');
        if (img) img.src = `/characters/${encodeURIComponent(character.avatar)}`;
        preview.style.display = '';
    } else {
        preview.style.display = 'none';
    }
}

// ============================================================
// SETTINGS UI
// ============================================================

function createSettingsUI() {
    const settings = getSettings();
    const container = document.getElementById('extensions_settings');
    if (!container) return;

    const html = `
        <div class="iig-settings" id="iig_settings_root">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>🎨 Inline Image Generation v3.0</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">

                    <!-- Enable toggle -->
                    <label class="checkbox_label" style="margin-bottom:10px;">
                        <input type="checkbox" id="iig_enabled" ${settings.enabled ? 'checked' : ''}>
                        <span>Включить генерацию картинок</span>
                    </label>

                    <!-- ======= SECTION: API ======= -->
                    <div class="iig-collapsible" data-section-id="api">
                        <div class="iig-collapsible-header">
                            <i class="fa-solid fa-chevron-down iig-collapse-icon"></i>
                            <span>🔌 API и модель</span>
                        </div>
                        <div class="iig-collapsible-content">

                            <!-- Presets -->
                            <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
                                <label style="font-size:11px;color:#9a9292;flex-shrink:0;">Пресет:</label>
                                <select id="iig_preset_select" class="flex1" style="font-size:11px;"></select>
                                <div class="menu_button" id="iig_preset_save" title="Сохранить текущие настройки как новый пресет"><i class="fa-solid fa-floppy-disk"></i></div>
                                <div class="menu_button" id="iig_preset_update" title="Обновить выбранный пресет текущими настройками"><i class="fa-solid fa-arrows-rotate"></i></div>
                                <div class="menu_button" id="iig_preset_delete" title="Удалить выбранный пресет" style="color:#cc5555;"><i class="fa-solid fa-trash"></i></div>
                            </div>

                            <div class="flex-row">
                                <label>Тип API</label>
                                <select id="iig_api_type" class="flex1">
                                    <option value="openai" ${settings.apiType === 'openai' ? 'selected' : ''}>OpenAI-совместимый</option>
                                    <option value="gemini" ${settings.apiType === 'gemini' ? 'selected' : ''}>Gemini (nano-banana)</option>
                                </select>
                            </div>

                            <div class="flex-row">
                                <label>Эндпоинт</label>
                                <input type="text" id="iig_endpoint" class="text_pole flex1" value="${settings.endpoint || ''}" placeholder="https://api.openai.com">
                            </div>

                            <div class="flex-row">
                                <label>API ключ</label>
                                <input type="password" id="iig_api_key" class="text_pole flex1" value="${settings.apiKey || ''}" placeholder="sk-...">
                                <div class="menu_button iig-key-toggle" id="iig_key_toggle"><i class="fa-solid fa-eye"></i></div>
                            </div>

                            <div class="flex-row">
                                <label>Модель</label>
                                <select id="iig_model" class="flex1">
                                    ${settings.model ? `<option value="${settings.model}" selected>${settings.model}</option>` : '<option value="">Выберите модель</option>'}
                                </select>
                                <div class="menu_button iig-refresh-btn" id="iig_refresh_models" title="Обновить список моделей"><i class="fa-solid fa-arrows-rotate"></i></div>
                            </div>

                            <div class="flex-row">
                                <label>Размер (OpenAI)</label>
                                <select id="iig_size" class="flex1">
                                    <option value="1024x1024" ${settings.size === '1024x1024' ? 'selected' : ''}>1024×1024</option>
                                    <option value="1536x1024" ${settings.size === '1536x1024' ? 'selected' : ''}>1536×1024</option>
                                    <option value="1024x1536" ${settings.size === '1024x1536' ? 'selected' : ''}>1024×1536</option>
                                    <option value="auto" ${settings.size === 'auto' ? 'selected' : ''}>auto</option>
                                </select>
                            </div>

                            <div class="flex-row">
                                <label>Качество</label>
                                <select id="iig_quality" class="flex1">
                                    <option value="standard" ${settings.quality === 'standard' ? 'selected' : ''}>standard</option>
                                    <option value="hd" ${settings.quality === 'hd' ? 'selected' : ''}>hd</option>
                                    <option value="low" ${settings.quality === 'low' ? 'selected' : ''}>low</option>
                                </select>
                            </div>

                            <div id="iig_gemini_section" class="${settings.apiType !== 'gemini' ? 'hidden' : ''}">
                                <div class="flex-row">
                                    <label>Aspect Ratio</label>
                                    <select id="iig_aspect_ratio" class="flex1">
                                        ${['1:1','2:3','3:2','3:4','4:3','4:5','5:4','9:16','16:9','21:9'].map(r =>
                                            `<option value="${r}" ${settings.aspectRatio === r ? 'selected' : ''}>${r}</option>`
                                        ).join('')}
                                    </select>
                                </div>
                                <div class="flex-row">
                                    <label>Image Size</label>
                                    <select id="iig_image_size" class="flex1">
                                        ${['1K','2K','4K'].map(s =>
                                            `<option value="${s}" ${settings.imageSize === s ? 'selected' : ''}>${s}</option>`
                                        ).join('')}
                                    </select>
                                </div>
                            </div>

                        </div>
                    </div>

                    <!-- ======= SECTION: Style ======= -->
                    <div class="iig-collapsible" data-section-id="style">
                        <div class="iig-collapsible-header">
                            <i class="fa-solid fa-chevron-down iig-collapse-icon"></i>
                            <span>🎨 Стиль по умолчанию</span>
                        </div>
                        <div class="iig-collapsible-content">
                            <textarea id="iig_default_style" class="text_pole" rows="3" placeholder="Стиль, добавляемый ко всем генерациям...">${settings.defaultStyle || ''}</textarea>
                            <p class="hint">Этот стиль будет добавлен к каждому промпту автоматически.</p>
                        </div>
                    </div>

                    <!-- ======= SECTION: Avatars ======= -->
                    <div class="iig-collapsible" data-section-id="avatars">
                        <div class="iig-collapsible-header">
                            <i class="fa-solid fa-chevron-down iig-collapse-icon"></i>
                            <span>👤 Аватары и референсы</span>
                        </div>
                        <div class="iig-collapsible-content">
                            <label class="checkbox_label">
                                <input type="checkbox" id="iig_auto_detect_names" ${settings.autoDetectNames ? 'checked' : ''}>
                                <span>Авто-определение имён в промпте</span>
                            </label>
                            <p class="hint">Если имя персонажа/юзера найдено в промпте картинки, аватар отправится автоматически.</p>

                            <label class="checkbox_label">
                                <input type="checkbox" id="iig_send_char_avatar" ${settings.sendCharAvatar ? 'checked' : ''}>
                                <span>Всегда отправлять аватар персонажа</span>
                            </label>
                            <div id="iig-char-avatar-preview" class="iig-avatar-preview" style="margin-bottom:8px;">
                                <img src="" alt="Аватар персонажа">
                            </div>

                            <label class="checkbox_label">
                                <input type="checkbox" id="iig_send_user_avatar" ${settings.sendUserAvatar ? 'checked' : ''}>
                                <span>Всегда отправлять аватар юзера</span>
                            </label>

                            <div id="iig_user_avatar_row" class="${!settings.sendUserAvatar ? 'hidden' : ''}" style="margin-top:4px;">
                                <div class="flex-row">
                                    <label>Аватар юзера</label>
                                    <div class="iig-avatar-dropdown flex1" id="iig_avatar_dropdown">
                                        <div class="iig-avatar-dropdown-selected" id="iig_avatar_dropdown_selected">
                                            ${settings.userAvatarFile
                                                ? `<img class="iig-dropdown-thumb" src="/User Avatars/${encodeURIComponent(settings.userAvatarFile)}">
                                                   <span class="iig-dropdown-text">${settings.userAvatarFile}</span>`
                                                : `<div class="iig-dropdown-placeholder"><i class="fa-solid fa-user"></i></div>
                                                   <span class="iig-dropdown-text">Не выбран</span>`
                                            }
                                            <i class="fa-solid fa-chevron-down iig-dropdown-arrow"></i>
                                        </div>
                                        <div class="iig-avatar-dropdown-list" id="iig_avatar_dropdown_list"></div>
                                    </div>
                                    <div class="menu_button iig-refresh-btn" id="iig_refresh_avatars" title="Обновить список"><i class="fa-solid fa-arrows-rotate"></i></div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- ======= SECTION: Wardrobe Char ======= -->
                    <div class="iig-collapsible" data-section-id="wardrobe_char">
                        <div class="iig-collapsible-header">
                            <i class="fa-solid fa-chevron-down iig-collapse-icon"></i>
                            <span>👗 Гардероб — Персонаж</span>
                        </div>
                        <div class="iig-collapsible-content">
                            <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
                                <input type="text" id="iig_wardrobe_char_name" class="text_pole flex1" placeholder="Название наряда...">
                                <div class="menu_button" id="iig_wardrobe_char_add"><i class="fa-solid fa-plus"></i> Добавить</div>
                                <input type="file" id="iig_wardrobe_char_file" accept="image/*" style="display:none;">
                            </div>
                            <div id="iig_wardrobe_char"></div>
                        </div>
                    </div>

                    <!-- ======= SECTION: Wardrobe User ======= -->
                    <div class="iig-collapsible" data-section-id="wardrobe_user">
                        <div class="iig-collapsible-header">
                            <i class="fa-solid fa-chevron-down iig-collapse-icon"></i>
                            <span>👗 Гардероб — Юзер</span>
                        </div>
                        <div class="iig-collapsible-content">
                            <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
                                <input type="text" id="iig_wardrobe_user_name" class="text_pole flex1" placeholder="Название наряда...">
                                <div class="menu_button" id="iig_wardrobe_user_add"><i class="fa-solid fa-plus"></i> Добавить</div>
                                <input type="file" id="iig_wardrobe_user_file" accept="image/*" style="display:none;">
                            </div>
                            <div id="iig_wardrobe_user"></div>
                        </div>
                    </div>

                    <!-- ======= SECTION: Wardrobe Injection ======= -->
                    <div class="iig-collapsible" data-section-id="wardrobe_inject">
                        <div class="iig-collapsible-header">
                            <i class="fa-solid fa-chevron-down iig-collapse-icon"></i>
                            <span>💉 Инжект гардероба в чат</span>
                        </div>
                        <div class="iig-collapsible-content">
                            <label class="checkbox_label">
                                <input type="checkbox" id="iig_inject_wardrobe" ${settings.injectWardrobeToChat ? 'checked' : ''}>
                                <span>Инжектить описание одежды в чат</span>
                            </label>
                            <p class="hint">Описание активной одежды будет добавлено в контекст для текстовой модели.</p>
                            <div class="flex-row">
                                <label>Глубина инжекта</label>
                                <input type="number" id="iig_wardrobe_injection_depth" class="text_pole" value="${settings.wardrobeInjectionDepth || 1}" min="0" max="100" style="width:70px;">
                            </div>
                        </div>
                    </div>

                    <!-- ======= SECTION: Vision API ======= -->
                    <div class="iig-collapsible" data-section-id="vision">
                        <div class="iig-collapsible-header">
                            <i class="fa-solid fa-chevron-down iig-collapse-icon"></i>
                            <span>🤖 Vision API для описаний одежды</span>
                        </div>
                        <div class="iig-collapsible-content">
                            <p class="hint">Отдельный API для генерации текстовых описаний одежды по картинке. Если не настроено, используется основной API.</p>
                            <div class="flex-row">
                                <label>Эндпоинт</label>
                                <input type="text" id="iig_wardrobe_desc_endpoint" class="text_pole flex1" value="${settings.wardrobeDescEndpoint || ''}" placeholder="Оставьте пустым для основного">
                            </div>
                            <div class="flex-row">
                                <label>API ключ</label>
                                <input type="password" id="iig_wardrobe_desc_api_key" class="text_pole flex1" value="${settings.wardrobeDescApiKey || ''}" placeholder="Оставьте пустым для основного">
                                <div class="menu_button iig-key-toggle" id="iig_desc_key_toggle"><i class="fa-solid fa-eye"></i></div>
                            </div>
                            <div class="flex-row">
                                <label>Модель</label>
                                <select id="iig_wardrobe_desc_model" class="flex1">
                                    ${settings.wardrobeDescModel ? `<option value="${settings.wardrobeDescModel}" selected>${settings.wardrobeDescModel}</option>` : '<option value="">Выберите модель</option>'}
                                </select>
                                <div class="menu_button iig-refresh-btn" id="iig_refresh_desc_models" title="Обновить"><i class="fa-solid fa-arrows-rotate"></i></div>
                            </div>
                            <div class="flex-row" style="align-items:flex-start;">
                                <label>Промпт</label>
                                <textarea id="iig_wardrobe_desc_prompt" class="text_pole flex1" rows="3">${settings.wardrobeDescPrompt || ''}</textarea>
                            </div>
                        </div>
                    </div>

                    <!-- ======= SECTION: NPC ======= -->
                    <div class="iig-collapsible" data-section-id="npc">
                        <div class="iig-collapsible-header">
                            <i class="fa-solid fa-chevron-down iig-collapse-icon"></i>
                            <span>🎭 NPC-референсы</span>
                        </div>
                        <div class="iig-collapsible-content">
                            <p class="hint">Добавьте NPC с картинками. Если имя NPC появляется в промпте картинки, его аватар будет отправлен как референс.</p>
                            <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
                                <input type="text" id="iig_npc_new_name" class="text_pole flex1" placeholder="Имя NPC...">
                                <div class="menu_button" id="iig_npc_add"><i class="fa-solid fa-plus"></i> Добавить</div>
                            </div>
                            <div id="iig_npc_list"></div>
                        </div>
                    </div>

                    <!-- ======= SECTION: Error Handling & Logs ======= -->
                    <div class="iig-collapsible" data-section-id="errors">
                        <div class="iig-collapsible-header">
                            <i class="fa-solid fa-chevron-down iig-collapse-icon"></i>
                            <span>⚙️ Генерация и ошибки</span>
                        </div>
                        <div class="iig-collapsible-content">
                            <div class="flex-row">
                                <label>Макс. повторов</label>
                                <input type="number" id="iig_max_retries" class="text_pole" value="${settings.maxRetries}" min="0" max="10" style="width:70px;">
                            </div>
                            <div class="flex-row">
                                <label>Задержка повтора (мс)</label>
                                <input type="number" id="iig_retry_delay" class="text_pole" value="${settings.retryDelay}" min="500" max="30000" step="500" style="width:90px;">
                            </div>
                            <div class="flex-row">
                                <label>Таймаут (сек)</label>
                                <input type="number" id="iig_request_timeout" class="text_pole" value="${settings.requestTimeout}" min="10" max="600" style="width:70px;">
                            </div>
                            <div style="margin-top:8px;">
                                <div class="menu_button" id="iig_export_logs"><i class="fa-solid fa-download"></i> Экспорт логов</div>
                            </div>
                        </div>
                    </div>

                </div>
            </div>
        </div>
    `;

    container.insertAdjacentHTML('beforeend', html);

    bindSettingsEvents();
    initCollapsibleSections();
    updateCharAvatarPreview();
    renderPresetSelect();
}

function bindSettingsEvents() {
    const settings = getSettings();

    document.getElementById('iig_enabled')?.addEventListener('change', (e) => { settings.enabled = e.target.checked; saveSettings(); });

    document.getElementById('iig_api_type')?.addEventListener('change', (e) => {
        settings.apiType = e.target.value; saveSettings();
        document.getElementById('iig_gemini_section')?.classList.toggle('hidden', e.target.value !== 'gemini');
    });

    document.getElementById('iig_endpoint')?.addEventListener('input', (e) => { settings.endpoint = e.target.value; saveSettings(); });
    document.getElementById('iig_api_key')?.addEventListener('input', (e) => { settings.apiKey = e.target.value; saveSettings(); });

    document.getElementById('iig_key_toggle')?.addEventListener('click', () => {
        const input = document.getElementById('iig_api_key');
        const icon = document.querySelector('#iig_key_toggle i');
        if (input.type === 'password') { input.type = 'text'; icon.classList.replace('fa-eye', 'fa-eye-slash'); }
        else { input.type = 'password'; icon.classList.replace('fa-eye-slash', 'fa-eye'); }
    });

    document.getElementById('iig_model')?.addEventListener('change', (e) => {
        settings.model = e.target.value; saveSettings();
        if (isGeminiModel(e.target.value)) {
            document.getElementById('iig_api_type').value = 'gemini';
            settings.apiType = 'gemini';
            document.getElementById('iig_gemini_section')?.classList.remove('hidden');
        }
    });

    document.getElementById('iig_refresh_models')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget; btn.classList.add('loading');
        try {
            const models = await fetchModels();
            const select = document.getElementById('iig_model');
            const current = settings.model;
            select.innerHTML = '<option value="">-- Выберите модель --</option>';
            for (const m of models) {
                const opt = document.createElement('option');
                opt.value = m; opt.textContent = m; opt.selected = m === current;
                select.appendChild(opt);
            }
            toastr.success(`Найдено моделей: ${models.length}`, 'Генерация картинок');
        } catch (err) { toastr.error('Ошибка загрузки моделей'); }
        finally { btn.classList.remove('loading'); }
    });

    document.getElementById('iig_size')?.addEventListener('change', (e) => { settings.size = e.target.value; saveSettings(); });
    document.getElementById('iig_quality')?.addEventListener('change', (e) => { settings.quality = e.target.value; saveSettings(); });
    document.getElementById('iig_aspect_ratio')?.addEventListener('change', (e) => { settings.aspectRatio = e.target.value; saveSettings(); });
    document.getElementById('iig_image_size')?.addEventListener('change', (e) => { settings.imageSize = e.target.value; saveSettings(); });

    document.getElementById('iig_default_style')?.addEventListener('input', (e) => { settings.defaultStyle = e.target.value; saveSettings(); });

    document.getElementById('iig_auto_detect_names')?.addEventListener('change', (e) => { settings.autoDetectNames = e.target.checked; saveSettings(); });

    document.getElementById('iig_send_char_avatar')?.addEventListener('change', (e) => { settings.sendCharAvatar = e.target.checked; saveSettings(); });

    document.getElementById('iig_send_user_avatar')?.addEventListener('change', (e) => {
        settings.sendUserAvatar = e.target.checked; saveSettings();
        document.getElementById('iig_user_avatar_row')?.classList.toggle('hidden', !e.target.checked);

        
    });

    // Avatar dropdown
    document.getElementById('iig_avatar_dropdown_selected')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const dropdown = document.getElementById('iig_avatar_dropdown');
        if (dropdown) {
            const wasOpen = dropdown.classList.contains('open');
            dropdown.classList.toggle('open');
            if (!wasOpen) {
                const list = document.getElementById('iig_avatar_dropdown_list');
                if (list && list.children.length === 0) loadAndRenderAvatars();
            }
        }
    });

    document.addEventListener('click', (e) => {
        const dropdown = document.getElementById('iig_avatar_dropdown');
        if (dropdown && !dropdown.contains(e.target)) dropdown.classList.remove('open');
    });

    document.getElementById('iig_refresh_avatars')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        const btn = e.currentTarget; btn.classList.add('loading');
        await loadAndRenderAvatars();
        btn.classList.remove('loading');
        toastr.success('Аватары обновлены');
        const dropdown = document.getElementById('iig_avatar_dropdown');
        if (dropdown) dropdown.classList.add('open');
    });

    // Wardrobe injection
    document.getElementById('iig_inject_wardrobe')?.addEventListener('change', (e) => {
        settings.injectWardrobeToChat = e.target.checked; saveSettings(); updateWardrobeInjection();
    });

    document.getElementById('iig_wardrobe_injection_depth')?.addEventListener('input', (e) => {
        settings.wardrobeInjectionDepth = parseInt(e.target.value) || 1; saveSettings(); updateWardrobeInjection();
    });

    // Wardrobe add buttons
    const bindWardrobeAdd = (target) => {
        const addBtn = document.getElementById(`iig_wardrobe_${target}_add`);
        const fileInput = document.getElementById(`iig_wardrobe_${target}_file`);
        const nameInput = document.getElementById(`iig_wardrobe_${target}_name`);
        addBtn?.addEventListener('click', () => fileInput?.click());
        fileInput?.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onloadend = async () => {
                const resized = await resizeImageBase64(reader.result.split(',')[1], 512);
                const name = nameInput?.value?.trim() || file.name.replace(/\.[^.]+$/, '') || 'Outfit';
                addWardrobeItem(name, resized, target);
                if (nameInput) nameInput.value = '';
                fileInput.value = '';
                renderWardrobeGrid(target);
                toastr.success(`Одежда "${name}" добавлена`);
            };
            reader.readAsDataURL(file);
        });
    };
    bindWardrobeAdd('char');
    bindWardrobeAdd('user');

    // Vision API settings
    document.getElementById('iig_wardrobe_desc_endpoint')?.addEventListener('input', (e) => { settings.wardrobeDescEndpoint = e.target.value; saveSettings(); });
    document.getElementById('iig_wardrobe_desc_api_key')?.addEventListener('input', (e) => { settings.wardrobeDescApiKey = e.target.value; saveSettings(); });

    document.getElementById('iig_desc_key_toggle')?.addEventListener('click', () => {
        const input = document.getElementById('iig_wardrobe_desc_api_key');
        const icon = document.querySelector('#iig_desc_key_toggle i');
        if (input.type === 'password') { input.type = 'text'; icon.classList.replace('fa-eye', 'fa-eye-slash'); }
        else { input.type = 'password'; icon.classList.replace('fa-eye-slash', 'fa-eye'); }
    });

    document.getElementById('iig_wardrobe_desc_model')?.addEventListener('change', (e) => { settings.wardrobeDescModel = e.target.value; saveSettings(); });

    document.getElementById('iig_refresh_desc_models')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget; btn.classList.add('loading');
        try {
            const models = await fetchDescriptionModels();
            const select = document.getElementById('iig_wardrobe_desc_model');
            select.innerHTML = '<option value="">-- Выберите --</option>';
            for (const m of models) {
                const opt = document.createElement('option');
                opt.value = m; opt.textContent = m; opt.selected = m === settings.wardrobeDescModel;
                select.appendChild(opt);
            }
            toastr.success(`Найдено текстовых моделей: ${models.length}`);
        } catch (err) { toastr.error('Ошибка загрузки моделей'); }
        finally { btn.classList.remove('loading'); }
    });

    document.getElementById('iig_wardrobe_desc_prompt')?.addEventListener('input', (e) => { settings.wardrobeDescPrompt = e.target.value; saveSettings(); });

    // NPC
    document.getElementById('iig_npc_add')?.addEventListener('click', () => {
        const nameInput = document.getElementById('iig_npc_new_name');
        const name = nameInput?.value?.trim();
        if (!name) { toastr.warning('Введите имя NPC'); return; }
        if (!settings.npcReferences) settings.npcReferences = [];
        if (settings.npcReferences.some(n => n.name.toLowerCase() === name.toLowerCase())) {
            toastr.warning(`NPC "${name}" уже существует`); return;
        }
        settings.npcReferences.push({ name, imageData: null, enabled: true });
        saveSettings();
        nameInput.value = '';
        renderNpcList();
        toastr.success(`NPC "${name}" добавлен. Загрузите картинку!`);
    });

        // ===== PRESETS =====
    document.getElementById('iig_preset_select')?.addEventListener('change', (e) => {
        const presetId = e.target.value;
        if (!presetId) {
            settings.activePresetId = null;
            saveSettings();
            return;
        }
        if (loadPreset(presetId)) {
            // Sync UI with loaded preset values
            const s = getSettings();
            const endpointEl = document.getElementById('iig_endpoint');
            const apiKeyEl = document.getElementById('iig_api_key');
            const apiTypeEl = document.getElementById('iig_api_type');
            const modelEl = document.getElementById('iig_model');
            const sizeEl = document.getElementById('iig_size');
            const qualityEl = document.getElementById('iig_quality');
            const aspectEl = document.getElementById('iig_aspect_ratio');
            const imgSizeEl = document.getElementById('iig_image_size');

            if (endpointEl) endpointEl.value = s.endpoint || '';
            if (apiKeyEl) apiKeyEl.value = s.apiKey || '';
            if (apiTypeEl) {
                apiTypeEl.value = s.apiType;
                document.getElementById('iig_gemini_section')?.classList.toggle('hidden', s.apiType !== 'gemini');
            }
            if (sizeEl) sizeEl.value = s.size;
            if (qualityEl) qualityEl.value = s.quality;
            if (aspectEl) aspectEl.value = s.aspectRatio;
            if (imgSizeEl) imgSizeEl.value = s.imageSize;

            // Refresh model list then select
            if (modelEl) {
                modelEl.innerHTML = `<option value="${s.model}" selected>${s.model}</option>`;
            }

            toastr.success('Пресет загружен', 'Пресеты API');
        }
    });

    document.getElementById('iig_preset_save')?.addEventListener('click', () => {
        const name = prompt('Название пресета:');
        if (!name?.trim()) return;
        saveCurrentAsPreset(name.trim());
        renderPresetSelect();
        toastr.success(`Пресет "${name}" сохранён`, 'Пресеты API');
    });

    document.getElementById('iig_preset_update')?.addEventListener('click', () => {
        const select = document.getElementById('iig_preset_select');
        const presetId = select?.value;
        if (!presetId) { toastr.warning('Сначала выберите пресет'); return; }
        const preset = settings.apiPresets.find(p => p.id === presetId);
        if (!preset) return;
        updatePresetFromCurrent(presetId);
        toastr.success(`Пресет "${preset.name}" обновлён`, 'Пресеты API');
    });

    document.getElementById('iig_preset_delete')?.addEventListener('click', () => {
        const select = document.getElementById('iig_preset_select');
        const presetId = select?.value;
        if (!presetId) { toastr.warning('Сначала выберите пресет'); return; }
        const preset = settings.apiPresets.find(p => p.id === presetId);
        if (!preset) return;
        if (!confirm(`Удалить пресет "${preset.name}"?`)) return;
        deletePreset(presetId);
        renderPresetSelect();
        toastr.info(`Пресет "${preset.name}" удалён`, 'Пресеты API');
    });

    // Error handling
    document.getElementById('iig_max_retries')?.addEventListener('input', (e) => { settings.maxRetries = parseInt(e.target.value) || 0; saveSettings(); });
    document.getElementById('iig_retry_delay')?.addEventListener('input', (e) => { settings.retryDelay = parseInt(e.target.value) || 1000; saveSettings(); });
    document.getElementById('iig_request_timeout')?.addEventListener('input', (e) => { settings.requestTimeout = parseInt(e.target.value) || 120; saveSettings(); });

    document.getElementById('iig_export_logs')?.addEventListener('click', exportLogs);

    // Render dynamic lists
    renderNpcList();
    renderWardrobeGrid('char');
    renderWardrobeGrid('user');
}

// ============================================================
// INIT
// ============================================================

(function init() {
    const context = SillyTavern.getContext();
    getSettings();

    context.eventSource.on(context.event_types.APP_READY, () => {
        createSettingsUI();
        addButtonsToExistingMessages();
        updateWardrobeInjection();
        console.log('[IIG] Inline Image Generation v3.0 loaded');
    });

    context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
        setTimeout(() => {
            addButtonsToExistingMessages();
            updateWardrobeInjection();
        }, 100);
        setTimeout(updateCharAvatarPreview, 200);
    });

    context.eventSource.makeLast(context.event_types.CHARACTER_MESSAGE_RENDERED, async (messageId) => {
        await onMessageReceived(messageId);
    });

    console.log('[IIG] Inline Image Generation v3.0 initialized');
})();
