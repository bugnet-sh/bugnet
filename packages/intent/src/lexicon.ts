/**
 * Keyword families for prompts, written against norm() output (lowercase, accents folded).
 *
 * Each family is a list of alternatives, one or more per line, bounded so a match never starts or
 * ends inside a word. English comes first in each family, then Turkish, Spanish, German and
 * Portuguese. The families come from the research notes in intent-signals.md, sections 2 and 3.
 */

// Lines are alternatives, and the match may not touch a letter, digit or underscore on either side
export function family(src: string): RegExp {
    const body = src
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "")
        .join("|");
    return new RegExp(`(?<![a-z0-9_])(?:${body})(?![a-z0-9_])`, "g");
}

export function find(re: RegExp, s: string): RegExpExecArray | null {
    re.lastIndex = 0;
    return re.exec(s);
}

// An exec loop, because matchAll clones the pattern on every call and costs several times more
export function findAll(re: RegExp, s: string): RegExpExecArray[] {
    const out: RegExpExecArray[] = [];
    re.lastIndex = 0;
    for (let m = re.exec(s); m !== null; m = re.exec(s)) {
        out.push(m);
        if (m[0] === "") re.lastIndex++;
    }
    return out;
}

/* Intent to run, install or try something */

export const action = family(String.raw`
    run|runs|running|rerun|execute|exec|launch|start|try|tries|trying|try out|test drive
    test (?:it|this|that|them|run)|spin (?:it |this |that |them )?up|set ?up|setting up
    (?:set|fire|boot) (?:it|this|that|them|everything) up
    install|installs|installing|reinstall|build|compile|wire (?:it |this )?up|hook (?:it |this )?up
    get (?:it|this|that|them|[^ \n]+(?: [^ \n]+){0,3}?) (?:running|working|going|up and running|to (?:actually )?(?:run|work))
    make (?:it|this|that) (?:work|run)|play (?:around )?with|host (?:it|this) locally
    download|redownload|pull|grab|fetch|unzip|unpack|extract|open (?:it|this|that)
    calistir\w*|calisir hale getir\w*|kur|kurmak|kurmam|kurup|kurar|kuralim|kurabilir\w*|kursana
    kurulum\w*|kurdum|kurun|kursun|kurman\w*|yukle\w*|indir\w*|dene|denemek|deneyelim|deneyin
    deneyebilir\w*|denesene|dener misin|baslat\w*|derle\w*|test et\w*|acar misin|acabilir\w*
    ejecut\w*|corre|correr|correlo|correrlo|corramos|corriendo|lanza|lanzar|lanzalo|lanzarlo
    instal\w*|prueba|pruebalo|probar|probarlo|probemos|arranc\w*|levanta|levantar|levantalo
    compil\w*|monta|montar|montalo|montarlo|descarg\w*|haz(?:lo)? funcionar|hacer funcionar
    ausfu(?:e)?hr\w*|fu(?:e)?hr\w* [^\n]{0,40}?\baus|start\w*|installier\w*|ausprobier\w*|probier\w*
    laufen lassen|zum laufen bringen|bring\w* [^\n]{0,40}?\bzum laufen|einricht\w*|richt\w* [^\n]{0,30}?\bein|kompilier\w*|aufsetz\w*
    herunterlad\w*|teste\w*
    rodar|roda|rode|rodando|executar|executa|instalar|instala|instale|testar|subir|configurar
    baixar|baixa|baixe|fazer funcionar|por pra rodar
`);

// Doing the AI task itself counts as intent for AI subjects
export const taskVerb = family(String.raw`
    transcrib\w*|transkribier\w*|desifre\w*|yaziya (?:dok|cevir|aktar)\w*|subtitl\w*|caption\w*|diariz\w*
    clone (?:my|a|his|her|their|this|the|someone'?s) (?:\w+ )?voice|clon(?:ar|a) (?:mi |la |su |a |minha |sua )?voz
    klon\w* (?:meine |die )?stimme|ses(?:imi|ini|i)? klon\w*|sesimi (?:kopyala|taklit)\w*
    narrate|read (?:it|this) (?:aloud|out loud)|seslendir\w*|vertonen|vorlesen
    (?:generate|create|make|render|produce|animate) (?:[^ \n]+ ){0,4}?(?:images?|pictures?|photos?|art|portraits?|shots?|clips?|videos?|animations?|songs?|music|voiceovers?|speech|audio)
    fine[- ]?tun\w*|finetun\w*|feintun\w*|train|training|trainier\w*|entrenar|treinar|egit\w*
    ince ayar\w*|ajuste fino|generar|gerar|generieren|erzeugen|olustur\w*|uret\w*|animar
    upscal\w*|inpaint\w*|chat with (?:it|the model|a model|llama|[a-z]+ \d+b)
`);

export const local = family(String.raw`
    locally|local|offline|self[- ]?host\w*|my own (?:gpu|hardware|machine)
    on (?:my|this|the) (?:own )?(?:machine|laptop|computer|mac|macbook(?: air| pro)?|pc|desktop|box|rig|workstation|gpu|hardware|disk|ssd)
    on my (?:m[1-5]\w*|rtx ?\d+|\d{4}|\d+ ?gb\w*)|on this (?:mac|laptop|machine|box)
    yerel\w*|lokal\w*|bilgisayar\w*|makine(?:m|mde|me|mi)\w*
    en local|localmente|en mi (?:pc|mac|maquina|ordenador|computadora|portatil|laptop|equipo)
    no meu (?:pc|mac|computador|notebook)|na minha maquina
    auf meine\w* (?:rechner|computer|laptop|pc|mac|maschine)|bei mir lokal
`);

/* Heavy local AI */

export const aiName = family(String.raw`
    xtts\w*|coqui|f5[- ]?tts|e2[- ]?tts|kokoro|piper[- ]?tts|styletts2?|openvoice|parler[- ]?tts
    chatterbox|orpheus[- ]?tts|csm[- ]?1b|dia[- ]?1\.6b|nari[- ]?labs|zonos|fish[- ]?speech
    spark[- ]?tts|vibevoice|higgs[- ]?audio|index[- ]?tts\w*|cosyvoice\w*|melo[- ]?tts
    qwen3?[- ]?tts|tortoise[- ]?tts|gpt[- ]?sovits|rvc|so[- ]?vits\w*|applio|alltalk|suno[- ]bark
    stable[- ]?diffusion|sd ?1\.5|sdxl|sd ?3(?:\.5)?|flux[.-]?[12](?:\.\d)?(?:[- ](?:dev|schnell|klein|kontext|pro))?
    flux[- ](?:dev|schnell|kontext|klein)|comfy ?ui|automatic1111|a1111|sd[- ]?webui|sd[- ]forge
    forge webui|webui forge|fooocus|invoke ?ai|qwen[- ]?image|z[- ]image|hidream|kohya\w*
    controlnet|civitai|txt2img|img2img|real[- ]?esrgan|diffusers
    wan ?2(?:\.\d)?|hunyuan ?video|ltx[- ]?(?:video|2(?:\.\d)?)|cogvideo\w*|mochi[- ]?1|animatediff
    stable video diffusion|svd[- ]xt|framepack|wav2lip|sadtalker|liveportrait|facefusion|roop
    deep[- ]?live[- ]?cam|open[- ]?sora
    ollama|llama\.?cpp|llamafile|lm ?studio|text[- ]generation[- ]webui|oobabooga|koboldcpp|vllm
    sglang|text[- ]generation[- ]inference|exllama\w*|gguf|ggml|mlx(?:[- ]lm)?|gpt4all
    (?:llama(?![- ]?index)|llava|qwen|mistral|mixtral|gemma|deepseek|codellama|nemotron|gpt[- ]oss|starcoder|vicuna)(?:[- ]?(?:r|v|coder)?\d+(?:\.\d+)?)?(?:[- :]?\d+(?:\.\d+)?b)?
    (?:phi|yi|granite|falcon|olmo)[- ]?\d+(?:\.\d+)?(?:[- :]?\d+(?:\.\d+)?b)?
    whisper(?:x|\.cpp|[- ]large\w*)?|faster[- ]whisper|distil[- ]whisper|insanely[- ]fast[- ]whisper
    parakeet|nvidia canary|wav2vec2?|vosk|pyannote
    musicgen|audiocraft|stable audio|riffusion|ace[- ]step|diffrhythm|audioldm|demucs|uvr5?
    yolov?\d+\w*|ultralytics|detectron2|mmdetection|segment anything|sam ?2|nanogpt|dreambooth
    textual inversion|unsloth|axolotl|deepspeed|torchrun|accelerate launch|fluxgym|ai[- ]toolkit
`);

// Names that are also ordinary words, counted only next to AI vocabulary
export const aiWeakName = family(String.raw`
    bark|piper|flux|forge|orpheus|sesame|krea
`);

export const aiContext = family(String.raw`
    tts|text[- ]to[- ]speech|voices?|speech|images?|video|models?|weights|checkpoints?|lora
    diffusion|ai|llm|gpu|vram
`);

export const aiTask = family(String.raw`
    text[- ]to[- ](?:speech|image|video|music|audio)|image[- ]to[- ](?:video|image)|speech[- ]to[- ]text
    tts|stt|voice ?(?:clone|cloner|cloning|changer|conversion|model)|ai voice|ai cover|voice ?over\w*
    audiobook|sesli kitap|texto a voz|sintesis de voz|clonacion de voz|clonagem de voz|text[- ]?zu[- ]?sprache
    sprachsynthese|stimmklon\w*|ki[- ]?stimme|horbuch
    (?:ai|open[- ]source|local|diffusion) (?:image|video|art|music|voice|speech) (?:model|generator|generation)
    (?:image|video|music) (?:generation|generator|diffusion) model|(?:generative|diffusion|text[- ]to[- ]\w+) (?:image |video )?model
    local (?:llm|model|ai|chatgpt|gpt|language model)|self[- ]host(?:ed)? (?:llm|model|ai)|(?:llm|model) locally
    yerel (?:bir )?(?:llm|model|yapay zeka|dil modeli)|lokal\w* (?:llm|modell|sprachmodell|ki)
    (?:llm|modelo) (?:en )?local|ia local|modelo local
    fine[- ]?tun\w*|finetun\w*|feintun\w*|q?lora|ince ayar\w*|ajuste fino
    (?:entrenar|treinar|trainier\w*|egit\w*) (?:un |uma |ein |mein |mi )?(?:modelo|model\w*|lora|voz|stimme)
    (?:model|lora|ses)\w* egit\w*|train (?:a |an |my |the )?(?:\w+ )?(?:model|lora|network|classifier|detector) (?:from scratch|on)
    transcri(?:be|bing|ption|pt)\w*|transkri\w*|desifre\w*|diariz\w*
    upscal\w*|inpaint\w*|lip ?sync\w*|talking head|face ?swap\w*|deepfake\w*|yuz degistir\w*
    intercambio de caras|gesichtstausch
    (?:generar|crear|gerar|criar|animar) (?:\w+ ){0,2}?(?:imagenes|imagens|fotos|video|videos|ilustraciones)
    (?:imagenes?|imagens?|videos?) con ia|(?:bilder?|video) (?:\w+ )?(?:generieren|erzeugen|erstellen)
    (?:resim|gorsel|video)\w* (?:olustur|uret)\w*|yapay zeka (?:ile )?(?:resim|gorsel|video|ses)\w*
`);

export const videoName = family(String.raw`
    wan ?2(?:\.\d)?|hunyuan ?video|ltx[- ]?(?:video|2)|cogvideo\w*|mochi[- ]?1|animatediff
    stable video diffusion|framepack|text[- ]to[- ]video|image[- ]to[- ]video|video model
`);

// Parameter counts such as 70b or 1.5b
export const paramSize = /(?<![a-z0-9_.])(\d{1,3}(?:\.\d)?) ?b(?![a-z0-9_])/g;

export const weightsCue = family(String.raw`
    \d+ ?(?:gb|gigs?|gigabytes?) (?:of )?(?:weights|models?|checkpoints?|downloads?)|weights|checkpoints?|safetensors
`);

/* Code the user has not vetted */

export const repoUrl =
    /(?:https?:\/\/)?(?:www\.)?(?:github\.com|gitlab\.com|codeberg\.org|bitbucket\.org|gitee\.com|sourceforge\.net)\/[\w.-]+\/[\w.-]*[\w-]|git@(?:github\.com|gitlab\.com|bitbucket\.org):[\w.-]+\/[\w.-]*[\w-]/g;

export const hfUrl =
    /(?:https?:\/\/)?huggingface\.co\/(?:spaces\/|datasets\/)?[\w.-]+\/[\w.-]*[\w-]/g;

export const anyUrl = /https?:\/\/[^\s'"<>)\]]{0,400}[^\s'"<>)\].,;:!?]/g;

export const scriptUrl =
    /https?:\/\/[^\s'"<>)\]]{1,400}\.(?:sh|bash|ps1|py|js|bat|cmd|vbs)(?![\w])/g;

export const ownRepoBefore = family(String.raw`
    (?:my|our|mine|benim|kendi|mi|nuestro|meu|nosso|mein\w*|unser\w*) (?:own |propio |eigene\w* )?(?:\w+ )?(?:repo|repository|fork|project|app|site|code|repom|projem|proyecto|projeto|projekt)\w*[ :]*(?:at |on |from |is |here |-)?$
`);

export const origin = family(String.raw`
    (?:found|saw|seen|got|spotted|came across)\b[^\n]{0,40}?\b(?:on|in|at|from|via) (?:a |an |the |some )?(?:\w+ ){0,2}?(?:reddit|discord|telegram|youtube|tiktok|twitter|tweet|x\.com|forum|thread|blog|medium|pastebin|hacker news|4chan|facebook|instagram|whatsapp|random site|website|video|stream|server|group|channel)
    from (?:a |an |the |some )?(?:\w+ ){0,2}?(?:reddit|discord|telegram|youtube|tiktok|twitter|tweet|forum|thread|pastebin|hacker news|4chan|random site|blog comment)
    (?:a friend|my friend|friend|someone|somebody|some guy|a guy|a stranger|my cousin|my brother|a recruiter|the recruiter|recruiter|a client|a vendor|a person|this guy)\b[^\n]{0,40}?\b(?:sent|shared|linked|gave|dm'?d|dmed|emailed|posted|recommended|uploaded|said)
    take[- ]home|coding (?:test|challenge|assignment|exercise)|interview (?:task|project|assignment|test)
    tech(?:nical)? (?:test|assessment)
    (?:reddit|discord|telegram|youtube|tiktok|twitter|forum|eksi|instagram)\w*'?(?:te|ta|de|da|ten|tan|den|dan|deki|daki)
    (?:arkadasim|biri|birisi|kuzenim|ise alimci|musteri)\w* [^\n]{0,30}?(?:gonderdi|atti|yolladi|paylasti|verdi)
    (?:mulakat|ise alim|case|teknik) (?:odevi|gorevi|projesi|testi)
    (?:lo |la )?(?:encontre|vi) en (?:\w+ ){0,2}?(?:reddit|discord|telegram|youtube|tiktok|twitter|un foro|foro)
    (?:en|de) (?:un |el )?(?:foro|reddit|discord|telegram|youtube|tiktok)
    me (?:lo |la )?(?:mando|paso|envio|compartio) (?:un amigo|alguien|un reclutador|un cliente|mi primo)
    prueba tecnica|ejercicio de (?:entrevista|seleccion)|reclutador
    (?:auf|bei|in) (?:\w+ )?(?:reddit|discord|telegram|youtube|tiktok|twitter|einem forum|forum) (?:gefunden|gesehen)
    (?:ein freund|ein kumpel|jemand|ein recruiter|ein kunde)[^\n]{0,30}?(?:geschickt|gesendet|geteilt)
    (?:probe|test|bewerbungs)aufgabe|vorstellungsgesprach
    (?:achei|vi|encontrei)[^\n]{0,40}?(?:no|num|na|em um|em uma) (?:\w+ ){0,2}?(?:youtube|reddit|discord|telegram|tiktok|twitter|forum)
    (?:um amigo|alguem|meu primo|um recrutador)[^\n]{0,30}?(?:mandou|enviou|passou|compartilhou)
`);

export const lure = family(String.raw`
    cracked|keygen|serial key|activator|kms ?pico|pirated|warez|nulled|unlocker
    crack(?:s)? (?:for|of|version|download|setup|apk|exe)|free (?:\w+ )?(?:nitro|robux|v-?bucks|followers|likes|netflix|vip)
    (?:get|unlock|activate)\w* (?:\w+ ){0,3}?(?:premium|pro|plus) (?:\w+ ){0,2}?(?:for free|free|without paying)
    without paying|bypass (?:the )?(?:paywall|license|licensing|activation|drm)
    mod menu|aimbot|wallhack|wall hack|esp hack|triggerbot|spoofer|hwid|dll inject\w*|cheat engine
    game (?:hacks?|trainers?|cheats?)|auto ?farm\w*|autoclicker
    inject\w* (?:\w+ ){0,2}?into (?:the |a )?(?:running )?(?:game|process)
    (?:crack|cracked|keygen|patch|activator|kms)\w*\b[^\n]{0,30}?\b(?:photoshop|office|windows|adobe|fl studio|capcut|autocad|premiere|illustrator|lightroom|after effects|matlab|ableton|vegas|corel)
    (?:photoshop|office|windows|adobe|fl studio|capcut|autocad|premiere|illustrator|lightroom|after effects|matlab|ableton|vegas|corel)[^\n]{0,20}?\b(?:crack|cracked|keygen|activator|kirik|crackeado|craqueado)\w*
    (?:roblox|valorant|fortnite|cs2|csgo|counter[- ]strike|apex|warzone|rust|gta|minecraft|pubg|tarkov|overwatch|cod|r6|dota|genshin|free fire) (?:\w+ )?(?:cheats?|hacks?|esp|aimbot|scripts?|executor|injector|mod menu|trainer|exploit|unlocker|spoofer)
    (?:nitro|robux|token|account|gift ?card|v-?bucks) (?:gen|generator)|token (?:grabber|logger|stealer)
    stealer|remote access trojan|rat (?:builder|client|panel|tool)
    (?:wallet|seed phrase|seed|mnemonic|private key) (?:recover\w*|finder|cracker|checker|drainer|brute\w*)
    drainer|(?:recover|find|brute ?force|crack)\w* (?:\w+ ){0,3}?(?:seed phrase|mnemonic|wallet)
    airdrop (?:claim\w*|bot|farmer|farming|hunter|checker)|claim\w* (?:\w+ ){0,2}?airdrop
    (?:sniper|mev|sandwich|arbitrage|arb|pump|copy[- ]?trade|copytrade|volume|memecoin|crypto|forex|trading) (?:\w+ )?bots?
    (?:instagram|insta|tiktok|youtube|twitter|twitch|spotify) (?:\w+ )?(?:bot|booster|liker|viewer bot|follow bot|follower bot)
    (?:view|follower|like|follow)s? ?(?:bot|booster)|captcha (?:solver|bypass)
    (?:leaked|cracked|unlock\w*|free|premium|uncensored|jailbroken)\b[^\n]{0,30}?\b(?:claude code|copilot|cursor|chatgpt|sora|kling|seedance|ltx|z[_ -]?image|voicemod|comfyui|midjourney|elevenlabs|photoshop|adobe|capcut|fl studio)
    leaked (?:source|build|version|code|model)|uncensored (?:image|model|generator|ai)
    hile\w*|kirik (?:surum|program)\w*|korsan\w*|lisans (?:anahtari|kirma)\w*
    (?:bedava|ucretsiz) (?:nitro|robux|vp|vbucks|takipci|begeni|lisans|premium|pro)\w*|hesap (?:botu|calma)
    kripto (?:bot|cuzdan)\w*|cuzdan (?:kurtar|bul)\w*|takipci (?:botu|hilesi|bot)|sizdiril\w*
    trucos? (?:para|de) (?:juego|valorant|fortnite|roblox)|crackead[oa]|pirata|activador|licencia gratis
    gratis (?:premium|nitro|robux|pavos)|generador de (?:nitro|robux|cuentas)
    bot de (?:trading|cripto|seguidores)|recuperar (?:billetera|cartera|frase semilla)|filtrad[oa]
    raubkop\w*|aktivator|kostenlos\w* (?:premium|pro|nitro|robux|lizenz|vollversion)|vollversion gratis
    generator fu(?:e)?r (?:nitro|robux)|krypto[- ]?(?:bot|wallet)|trading[- ]?bot|wallet (?:wiederherstell\w*|knacken)
    geleakt\w*|craqueado|ativador|gerador de (?:robux|nitro)|hack\w* (?:de|pra|para) (?:minecraft|roblox|free fire)
`);

export const ownBefore =
    /(?:^|[\s(])(?:my|our|mine|mi|mis|meu|minha|nosso|benim|kendi|mein\w*|unser\w*|nuestro)\s(?:\S+\s){0,2}$/;

export const createBefore =
    /(?:build|write|create|make|code|develop|implement|scaffold|program)\s(?:me\s)?(?:a|an|my|our|the)\s(?:\S+\s){0,2}$/;

export const poc = family(String.raw`
    pocs?|proof[- ]of[- ]concept|exploits?|exploit code|cve-\d{4}-\d{3,7}|0[- ]?day|zero[- ]?day|rce|privesc
    lpe|reverse shell|bind shell|shellcode|msfvenom|metasploit|zafiyet\w*|guvenlik acig\w*|exploit'?\w*
    vulnerabilidad\w*|schwachstelle\w*|sicherheitslu(?:e)?cke\w*
`);

// File patterns start at the extension, which is several times faster than scanning each word
export const receivedFile =
    /\.(?:zip|rar|7z|exe|msi|scr|bat|cmd|ps1|vbs|jar|lnk|iso|dmg|pkg|app|apk|docm|xlsm|pptm|hta|pif)(?![a-z0-9_])/g;

export const receivedContext = family(String.raw`
    attachment|attached|e-?mail(?:ed)?|got an? (?:email|message|dm)|sent me|dm'?d me
    over (?:telegram|whatsapp|discord|email|signal|slack)|on whatsapp|never heard of
    unknown (?:sender|vendor|client)|ekte(?:ki)?|mail\w* gelen|adjunto|me enviaron|anhang|angehangt|anexo
    macros?|makro\w*
`);

export const disguisedFile =
    /\.(?:pdf|docx?|xlsx?|jpe?g|png|mp4|mp3|txt)\.(?:exe|scr|bat|cmd|js|vbs|lnk|com|pif)(?![a-z0-9_])/g;

export const enableMacros = family(String.raw`
    enable (?:the )?(?:macros|content|editing)|habilitar (?:macros|contenido)|makros aktivieren|inhalt aktivieren
`);

export const avOff = family(String.raw`
    xattr|com\.apple\.quarantine|quarantine (?:flag|attribute)|damaged and can'?t be opened|cant be opened
    can'?t be opened because|unidentified developer|spctl --master-disable
    (?:disable|turn off|switch off) (?:the )?(?:gatekeeper|sip|windows defender|defender|antivirus|av|smartscreen|real[- ]time protection)
    (?:defender|antivirus)\w* (?:kapat|devre disi)\w*|desactiva\w* (?:el )?(?:defender|antivirus)
    (?:defender|virenschutz|antivirus) (?:deaktivieren|ausschalten)|desativ\w* (?:o )?(?:defender|antivirus)
`);

export const safety = family(String.raw`
    is (?:this|it|that) (?:safe|legit|malware|malicious|a virus|a scam|sketchy|shady|trustworthy)
    safe to (?:run|install|open|use)|could (?:this|it) (?:be malicious|steal)
    (?:don'?t|dont|do not|not sure i) trust|untrusted|sketchy|shady|suspicious
    guvenli mi|zararli mi|virus(?:lu)? (?:mu|var mi)|kotu amacli|guvenilir mi|guvenmiyorum
    es seguro|es (?:un )?virus|es malware|es (?:una )?estafa|es confiable|no confio|sospechoso
    ist (?:das|es) sicher|schadsoftware|ist das malware|vertrauenswu(?:e)?rdig|verdachtig
    e seguro|nao confio|suspeito
`);

export const repoWord = family(String.raw`
    repo|repos|repository|repositorio|depo(?:su|yu|yi)?|repoyu|repoyi|reposu|binary|binaries|script|scripts
    tool|program|app|installer|plugin|extension|mod|bot|exe|zip|archive|command|take[- ]home|assignment
    projeto|programa|herramienta|skript|programm|arac|uygulama
`);

/* The user asks for isolation outright */

export const explicit = family(String.raw`
    (?:run|test|try|execute|exec|spin|launch|open|install|detonate|analy[sz]e|put|do|start)\w* (?:[^ \n]+ ){0,10}?(?:in|inside|into|within|on) (?:an? |some |one )?(?:throwaway |disposable |isolated |separate |remote |cloud |safe |temporary |temp |fresh |clean |ephemeral |cheap |linux |sandboxed )*(?:sandbox|vm|virtual machine|micro ?vm|sandboxed environment)
    sandbox(?:ed)? (?:somewhere|instead|first|vm|box|machine)
    (?:throwaway|disposable|burner) (?:linux |cloud )?(?:box|vm|machine|server|container|env\w*|sandbox|instance)
    (?:isolated|separate|temporary|ephemeral|fresh|clean) (?:linux |cloud )?(?:box|vm|machine|sandbox|micro ?vm)
    spin up an? (?:\w+ )?(?:vm|box|sandbox|machine)|(?:rent|borrow) an? (?:cloud )?(?:gpu|server|box|vm|machine)
    cloud (?:gpu|sandbox)|remote (?:gpu|sandbox)|bugnet
    kum ?havuzu\w*|sanal makine\w*|izole (?:bir )?ortam\w*|gecici (?:bir )?(?:sunucu|makine|ortam)\w*
    uzak (?:bir )?sunucu\w*|bulut\w* (?:makine|sunucu|gpu)\w*
    maquina virtual|entorno aislado|servidor remoto|en la nube|na nuvem|caja de arena
    virtuelle\w* maschine|isoliert\w* umgebung|in der cloud|entfernte\w* (?:server|maschine)|wegwerf\w*
`);

// Payment and browser sandboxes are not requests for an isolated machine
export const notIsolation = family(String.raw`
    iframe|stripe|paypal|braintree|plaid|adyen|sandbox (?:attribute|attr|flag|mode|account|keys?|credentials|api|url|domain)
`);

export const notMine = family(String.raw`
    (?:don'?t|dont|do not|rather not|would rather not|wouldn'?t|won'?t|never) (?:want|wanna|need|like|trust)[^\n]{0,50}?(?:on|in|onto|near|to touch) (?:my|this) (?:own )?(?:machine|laptop|computer|mac|macbook|pc|system|box|disk|drive|ssd|host)
    (?:anywhere |somewhere |remotely )?near my (?:machine|laptop|computer|mac|macbook|pc|system|files)
    (?:keep|stay) (?:it |this |that )?(?:off|away from) my (?:machine|laptop|computer|mac|pc|system)
    (?:instead of|not on|outside(?: of)?|away from|other than|that isn'?t|that is not|isn'?t|is not|but not on) (?:on )?my (?:own )?(?:machine|laptop|computer|mac|macbook|pc|system|box)
    (?:run|test|try|execute|install|do|put|host|detonate)\w* (?:[^ \n]+ ){0,4}?(?:(?:somewhere|someplace) (?:else|safe|isolated)|elsewhere)
    (?:bilgisayarim|makinem|laptopum|sistemim)\w*[^\n]{0,40}?(?:kurmak istemiyorum|calistirmak istemiyorum|bulasmasin|bozul\w*|kirlen\w*|zarar\w*)
    baska bir (?:makine|yer)\w*
    no quiero (?:instalar|ejecutar|correr|tener)\w*[^\n]{0,30}?en mi (?:pc|computadora|ordenador|maquina|portatil|laptop|mac|sistema)
    en otro (?:lado|sitio|equipo)|fuera de mi (?:pc|maquina|ordenador)
    nicht auf meine\w* (?:rechner|computer|laptop|pc|mac|system)|woanders
    nao quero (?:instalar|rodar|executar)[^\n]{0,30}?(?:no meu|na minha)|em outro lugar|fora do meu (?:pc|computador)
`);

/* Setups that do not fit the user's machine */

export const nvidiaOnly = family(String.raw`
    cuda(?:[- ]?\d+(?:\.\d+)?)?|nvidia(?: gpu| card| drivers?)?|cupy|numba\.cuda|flash[-_ ]?attn\w*|flash[- ]attention
    xformers|bitsandbytes|triton|tensorrt|cudnn|cuda[- ]toolkit|nvidia[- ]container[- ]toolkit|nvcc
    vllm|exllamav2|auto[- ]gptq|mamba[- ]ssm
`);

// A stated hard dependency on NVIDIA, or a package that only exists for it
export const nvidiaNeed = family(String.raw`
    (?:needs?|requires?|requiring|depends on|built for|only (?:runs|works) (?:on|with)|won'?t run without|must have)\b[^\n]{0,30}?\b(?:cuda|nvidia)
    (?:cuda|nvidia)[- ]only|cupy|numba\.cuda|flash[-_ ]?attn\w*|flash[- ]attention|xformers|bitsandbytes|triton|tensorrt
    vllm|exllamav2|auto[- ]gptq|mamba[- ]ssm|nvidia[- ]container[- ]toolkit
`);

export const rawDevice = family(String.raw`
    /dev/(?:sd[a-z]|nvme\d|disk\d|hd[a-z]|mmcblk\d)
`);

// Work aimed at a machine the user already runs elsewhere, or at CI
export const remoteTarget = family(String.raw`
    (?:on|in|to|onto|into) (?:the|our|my|a|an|this|that) (?:\w+ )?(?:server|vps|ec2|droplet|cluster|k8s|kubernetes|pod|runpod|colab|kaggle|lambda|homelab|nas|raspberry pi|ci|ci runner)
    (?:google )?colab|kaggle notebook|github actions|gitlab ci|dockerfile|devcontainer|codespace\w*|wsl2?
`);

export const hardwareGap = family(String.raw`
    (?:no|don'?t have (?:an?|a dedicated)?|dont have (?:an?)?|without (?:an?)?|lack (?:an?)?) (?:nvidia |dedicated |discrete )?(?:gpu|graphics card|cuda|nvidia)
    (?:has|have) no (?:nvidia |dedicated )?(?:gpu|graphics card)
    my (?:gpu|laptop|mac|machine|pc|computer) (?:is|has|only has) (?:too )?(?:weak|slow|old|only \d+ ?gb|\d+ ?gb)
    (?:only|just) (?:\d+ ?gb (?:of )?(?:ram|vram|memory)|integrated graphics)|not enough (?:ram|vram|memory|disk|space)
    ekran kartim (?:yok|zayif)|gpu\w* yok|ram\w* yetmiyor|bilgisayarim (?:yavas|zayif|eski)
    no tengo (?:gpu|tarjeta grafica)|mi (?:pc|portatil|laptop) es (?:lento|viejo)|poca ram
    keine (?:nvidia[- ])?(?:gpu|grafikkarte)|grafikkarte (?:zu schwach|reicht nicht)|zu wenig (?:ram|speicher)
    nao tenho (?:gpu|placa de video)
`);

export const linuxOnly = family(String.raw`
    (?:only|solo|nur|sadece|apenas|just) (?:\w+ ){0,3}?(?:on |en |auf |em )?linux|linux[- ]only|linux x86[_-]?64
    only (?:ships|supports|has|runs on|works on) (?:\w+ ){0,2}?linux|requires? linux|needs? linux
    ebpf|bpftrace|bcc tools|io_uring|systemd|systemctl|apt(?:-get)?|kvm|lxc|cgroups?|ip netns|nftables|iptables
    linux'?(?:ta|te|da|de)|linux binar\w*
`);

export const x86Only = family(String.raw`
    x86(?:[_-]64)?|amd64|intel mkl|mkl|avx[- ]?512|avx2?|rosetta|intel[- ]only|only (?:\w+ ){0,2}?intel
`);

export const macText = family(String.raw`
    mac|macs|macbook\w*|macos|mac os|apple silicon|m[1-5](?: pro| max| ultra| air)? (?:mac|macbook|chip)\w*
    (?:i'?m|im|i am) on (?:an? )?m[1-5]|mac kullaniyorum|uso (?:una )?mac
`);

export const windowsText = family(String.raw`
    (?:i'?m|im|i am) on windows|windows (?:10|11)|on my (?:windows|win) (?:pc|laptop|machine)
`);

export const driverText = family(String.raw`
    (?:install|update|upgrade|set ?up|kur\w*|instal\w*)\w* (?:the )?(?:nvidia|cuda|gpu|graphics) (?:drivers?|toolkit)
    (?:(?:nvidia|cuda|gpu|graphics)[- ](?:card )?)+(?:drivers?|toolkit)|drivers? for (?:my |the |an? )?(?:nvidia|gpu|graphics)
    kernel modul\w*|dkms|out[- ]of[- ]tree (?:driver|module)|custom kernel|kernel patch\w*
`);

/* Experiments that can break the machine */

export const destructive = family(String.raw`
    rm -[a-z]*r[a-z]*f?[a-z]* (?:--no-preserve-root )?(?:/|~|\$home|/\*|/usr|/etc|/bin|/var|/system)(?=\s|$)
    dd(?:[- ]based)? [^\n]{0,40}?(?:/dev/|disk|drive|ssd|speed test)
    mkfs\w*|wipefs|wipe (?:the |my )?(?:disk|drive|ssd|partition)|format (?:the |my )?(?:disk|drive|ssd|partition|c:)
    fork ?bomb|kernel panic|fill (?:up )?the disk|oom killer|break (?:my|the) (?:system|machine|os|install)
    chaos (?:test|engineering|monkey)|(?:disk|ssd)\w* (?:\w+ )?(?:sil|bicimlendir|formatla)\w*|sistemi bozabilir
    borrar el disco|formate(?:ar|o) (?:el |mi )?(?:disco|ssd|unidad)|romper el sistema
    festplatte (?:lo(?:e)?schen|formatieren)|formatier\w* (?:\w+ )?festplatte|system kaputt
    apagar o disco|format(?:ar|o) o (?:disco|hd|ssd)
`);

export const kernelText = family(String.raw`
    mitigations=off|kernel (?:param\w*|parameters?|args?|cmdline|tuning|modules?)|sysctl|grub|grubby
    cpufreq|hugepages|swappiness|selinux|apparmor|secure boot
`);

/* Long, heavy jobs */

export const heavyPhrase = family(String.raw`
    overnight|over night|while i sleep|(?:just )?(?:let|leave) it (?:go|run|running|cook|churn)
    leave it running|kick (?:it |this )?off|for (?:a few |several |many )?hours|takes? (?:hours|forever|days|ages)
    all night|for days|keep (?:it )?running|run for (?:like |about |around )?\d+ ?(?:h|hrs?|hours|days)
    toda la noche|durante horas|tarda horas|u(?:e)?ber nacht|stundenlang|gece boyunca|saatlerce
    a noite toda|durante a noite|por horas|demora horas|for (?:an|one|a full) hour|all day|for a day
`);

export const heavyTask = family(String.raw`
    param(?:eter)? sweep|grid search|hyperparameter (?:search|sweep|tuning)|backtest\w*|fuzz\w*|render\w*
    monte carlo|benchmark\w*|batch (?:job|process\w*)
`);

// Builds of projects so large that one local build takes an hour or more
export const longBuild = family(String.raw`
    (?:compile|build|compil\w*|derle\w*|kompilier\w*) (?:\w+ ){0,2}?(?:kernel|chromium|llvm|gcc|firefox|aosp|android|webkit|qt|tensorflow|pytorch)
`);

export const loadTest = family(String.raw`
    load[- ]?test\w*|stress[- ]?test\w*|soak test\w*|(?:\d+k?|thousands of) (?:rps|requests per second|concurrent (?:users|connections))
    yuk testi|prueba de carga|lasttest\w*|teste de carga
`);

export const heat = family(String.raw`
    laptop (?:overheats|gets hot|heats up)|fans? (?:spin|scream|go crazy|get loud)|drains? (?:my )?battery
    isiniyor|se calienta|wird hei(?:ss)?|lufter|esquenta
`);

export const hours =
    /(?<![\w.])(\d+(?:\.\d+)?) ?(?:h|hr|hrs|hours?|horas?|stunden?|std|saat\w*)(?![a-z])/g;
export const minutes =
    /(?<![\w.])(\d+) ?(?:min|mins|minutes?|minutos?|minuten?|dakika\w*)(?![a-z])/g;
export const repeats =
    /(?<![\w.])(\d+) (?:times|veces|vezes|mal|kez|defa|runs|iterations|builds)(?![a-z])/g;
export const batch =
    /(?<![\w.])(\d+(?:[.,]\d+)?)(k)?\+? ?(?:images|pictures|photos|files|videos|clips|recordings|episodes|tracks|songs|documents|pdfs|combos|combinations|samples|shots|avatars|lectures|podcasts|hours of (?:audio|video|footage))(?![a-z])/g;
export const wholeBatch = family(String.raw`
    (?:all|every|whole) (?:of )?(?:my|the|our) (?:\w+ )?(?:backlog|archive|library|recordings|footage|dataset|photos|videos|collection)
`);
export const epochs = /(?<![\w.])(\d+) epochs?(?![a-z])/g;

/* Signals against an offer */

export const concept = family(String.raw`
    ^(?:what|whats|what's|which|why|explain|eli5|how come|how much|how many|is it (?:possible|worth|safe|true)|should i|would it|do i need)
    how (?:does|do|did|is|are|would) (?:\S+ ){0,6}?(?:work|works|differ|compare|detect\w*|handle\w*)
    explain|walk me through
    (?:what'?s|what is) the difference|difference between|pros and cons|just curious|out of curiosity|theoretically|in theory
    nedir|nasil calisir|ne ise yarar|acikla\w*|farki ne\w*|ne kadar [^\n]{0,30}?(?:ister|gerekir|tutar)|merak ediyorum
    que es|como funciona|explica\w*|cual es la diferencia|por que
    was ist|wie funktioniert|erkla(?:e)?r\w*|was ist der unterschied|nur theoretisch|theoretisch
    o que (?:e|faz)|explicar|explique|qual a diferenca
`);

export const readOnly = family(String.raw`
    (?:just|only) (?:read|look at|browse|grep|review|audit|explain|inspect)
    (?:don'?t|dont|do not|without|no need to|not going to|won'?t|never) (?:\w+ ){0,2}?(?:run|execute|install|build)\w*(?: or (?:run|install|execute|build)\w*)? (?:anything|it|them|this|that)(?! (?:on|in|onto|near|locally|here|myself)(?![a-z]))
    read[- ]only
    sadece (?:oku|incele|bak)\w*|calistirma(?:dan|yin)|kurmadan
    solo (?:leer|revisar|mirar|explicar)|sin (?:ejecutar|instalar|correr)
    nur (?:lesen|anschauen|durchsehen|pru(?:e)?fen)|ohne (?:auszufu(?:e)?hren|zu installieren)
    nicht ausfu(?:e)?hren|nichts (?:installieren|ausfu(?:e)?hren)
    so explicar|nao precisa (?:mudar|rodar|executar)|sem (?:rodar|executar|instalar)
`);

export const hosted = family(String.raw`
    openai(?![ /-]whisper)|anthropic|claude api|gemini api|google (?:cloud )?(?:tts|speech|text-to-speech|vertex)
    vertex ai|azure (?:openai|speech|tts|cognitive)|aws polly|amazon polly|bedrock
    elevenlabs|eleven labs|replicate|deepgram|assembly ?ai|stability(?: ai)? api|api (?:da|de|der|del) stability
    together\.ai|together ai|fireworks\.ai|fireworks ai|groq|fal\.ai|runway ?ml|runway api|luma api|cartesia
    play\.?ht|hugging ?face inference|inference (?:api|endpoints?)|openrouter|cohere
    (?:mistral|deepseek|qwen|gemma|llama|perplexity|midjourney) (?:api|platform)|speechmatics|rev\.ai|hume ai
    api key|api_key|whisper api|(?:tts|speech|transcription|image generation|video generation) api
`);

export const notHostedBefore =
    /(?:instead of|rather than|without|replace|not|no|don'?t|dont|than|pay for)\s(?:\S+\s){0,3}$/;

export const offline = family(String.raw`
    offline (?:on|during|in) (?:a |the )?(?:flights?|planes?|trains?|trips?|commute|subway)
    (?:on|in) (?:a |the )?(?:plane|flight|airplane)|without (?:internet|wifi|wi-fi)|no (?:internet|wifi|connectivity)
    air[- ]?gapped|on my (?:phone|iphone|android|ipad)|on[- ]device|internetsiz|cevrimdisi|ucakta
    sin (?:internet|conexion)|en el avion|ohne internet|im flugzeug|sem internet|no aviao
`);

// Clause-local signs that the request is about the user's own work
export const own = family(String.raw`
    (?:my|our) (?:own )?(?:app|apps|application|project|repo|repository|code|codebase|service|api|server|site|website|portfolio|script|component|module|tests|test suite|library|lib|package|cli|bot|extension|plugin|mod|dotfiles|backend|frontend|dashboard|blog|startup|saas|game|fork|branch|pr|workflow|pipeline|infra|cluster|monorepo)
    (?:src|lib|app|routes|components|pages|tests?|spec|internal|cmd|pkg)/[^ \n]+\.(?:tsx?|jsx?|py|go|rs|rb|java|kt|swift|cs|php|vue|svelte)
    [\w-]+\.(?:tsx|jsx|vue|svelte)
    (?:benim|kendi) (?:projem|uygulamam|kodum|sitem|repom|botum)\w*|projemdeki|projemde|uygulamamda|kodumda|repomda
    (?:mi|nuestro|nuestra) (?:propio )?(?:proyecto|app|aplicacion|codigo|repo|sitio|pagina|bot|modulo|mod)
    (?:meu|minha|nosso|nossa) (?:proprio )?(?:projeto|app|aplicativo|aplicacao|codigo|repo|site|componente|bot|mod|modulo)
    (?:mein|meine|meinem|meinen|unser|unsere|unserem) (?:eigene\w* )?(?:projekt|code|app|repo|anwendung|seite|bot|modul)
`);

export const docs = family(String.raw`
    (?:write|draft|update|generate|create|add|improve) (?:\w+ ){0,3}?(?:readme|docs?|documentation|changelog|blog post|article|tutorial|plan doc|markdown|guide|docstrings)
    just the markdown|(?:readme|docs?|dokumantasyon|dokumentation|documentacion|documentacao)\w* (?:yaz|schreib|escrib|escrev)\w*
`);

export const tests = family(String.raw`
    (?:write|add|generate|create) (?:\w+ ){0,2}?(?:unit |integration |e2e )?tests?
    unit-?tests? (?:\w+ ){0,3}?schreib\w*|tests? unitarios|testes? unitarios|test(?:leri)? yaz\w*
`);

export const edit = family(String.raw`
    fix|refactor|rename|convert|clean up|tidy|lint|bump|upgrade|squash|commit|push|deploy|migrate|merge|rebase
    pull (?:the )?latest|latest changes|pull request|code review|review the
    corrige|arregla|refactoriza|duzelt\w*|behebe|reparier\w*|conserta
`);

/* Never offered */

export const abuse = family(String.raw`
    xmrig|cpuminer|minerd|nbminer|t-?rex miner|lolminer|phoenixminer|ethminer|xmr-?stak|srbminer|stratum\+tcp
    (?:crypto|bitcoin|btc|monero|xmr|eth|ethereum|coin|cpu|gpu|usdt)[- ]?min(?:er|ers|ing)|mine (?:monero|xmr|crypto|bitcoin|btc|eth|coins)
    cryptojack\w*|mining (?:pool|rig|script|software|bot)|minero|minerador|mineracao|madencilik|kripto kaz\w*
    minar (?:cripto|monero|bitcoin)|krypto[- ]?(?:minen|mining|schu(?:e)?rfen)
    booter|ip stresser|stresser|slowloris|hoic|loic|ddos|dos attack|syn flood|udp flood|http flood
    hping3 [^\n]{0,40}?--flood|flood(?:s|ing)? (?:the|a|their|his|her|this|that) (?:\w+ )?(?:server|site|website|network|ip|api|endpoint)
    masscan|zmap|scan the (?:whole |entire )?internet|internet[- ]wide scan|mass[- ]?scan\w*
    mass[- ]?(?:email|e-mail|dm|dms|sms|messag\w*|mail\w*)|bulk (?:sms|email|e-mail|dm|messag\w*|mail\w*)(?: sender| bot)?
    spam ?bot|spammer|auto[- ]?dm|toplu (?:sms|mail|mesaj)\w*|envio masivo|envios masivos|massenmail\w*|disparo em massa
    account (?:creator|generator)|hesap (?:olusturucu|acici)|credential stuffing|combo ?list
    brute ?forc\w* (?:\w+ ){0,2}?(?:instagram|facebook|gmail|ssh|rdp|login|logins|accounts?)|kaba kuvvet|fuerza bruta
`);

const privateNet = String.raw`(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.[\d./]+`;

export const lanScan = new RegExp(
    String.raw`(?<![a-z])(?:scan|nmap|port ?scan|sweep|enumerate|map|discover|tara|escane|scann)\w*[^\n]{0,60}?(?:${privateNet}|(?:my|our|the) (?:home |local |lab |office )?(?:network|lan|subnet|wifi)|home ?lab)|${privateNet}[^\n]{0,40}?(?:open ports|services?|scan)`,
    "g",
);

export const privateTarget = new RegExp(
    String.raw`^(?:${privateNet}|localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?)(?::\d+)?(?:/|$)`,
);
