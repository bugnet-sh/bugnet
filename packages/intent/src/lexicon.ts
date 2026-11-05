/**
 * Keyword families for prompts, written against norm() output (lowercase, accents folded).
 *
 * Each family is a list of alternatives, one or more per line, bounded so a match never starts or
 * ends inside a word. English comes first in each family, then Turkish, Spanish, German and
 * Portuguese, and a few families add French and Italian. The families come from the research
 * notes in intent-signals.md, sections 2 and 3.
 */

// Lines are alternatives bounded by non-word characters, and an optional space also allows a hyphen
export function family(src: string): RegExp {
    const body = src
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "")
        .join("|")
        .replace(/([a-z]) \?(?=[a-z(])/g, "$1[- ]?");
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
    faire tourner|fais tourner|executer|executez|lance|lancer|lancez|demarrer|essayer|essaie|telecharger
    eseguire|esegui|eseguilo|avviare|avvia|lanciare|lancia|provare|provalo|scaricare|scarica|far girare
`);

// A request aimed at pasted commands, as opposed to editing or explaining them
export const runsPasted = family(String.raw`
    (?:run|execute|exec|try|install|launch|start|paste|ejecut\w*|corre|correr|calistir\w*|ausfu(?:e)?hr\w*|rodar|roda|executar|instala\w*)(?: (?:it|this|that|these|them|those|the))?(?: (?:above|below|following|same))?(?: (?:install )?(?:commands?|scripts?|snippet|lines?|one[- ]liners?|installer|steps?|code|block))?(?= *(?:$|[\n,.!?:;]|(?:for|please|pls|on|in|here|now|again|first|and|then|so|to|from|locally|myself|anyway)(?![a-z])))
    (?:set|fire|boot) (?:it|this|that|them) up|get (?:it|this|that|them) (?:running|working|going)
    safe to (?:run|install|execute)|is (?:this|it|that) safe
`);

// Doing the AI task itself counts as intent for AI subjects
export const taskVerb = family(String.raw`
    transcrib\w*|transkribier\w*|desifre\w*|yaziya (?:dok|cevir|aktar)\w*|subtitl\w*|caption\w*|diariz\w*
    clone (?:my|a|his|her|their|this|the|someone'?s) (?:\w+ )?voice|clon(?:ar|a) (?:mi |la |su |a |minha |sua )?voz
    klon\w* (?:meine |die )?stimme|(?:meine|die) stimme (?:zu )?klon\w*|ses(?:imi|ini|i)? klon\w*|sesimi (?:kopyala|taklit)\w*
    clon\w* (?:(?:la|ma|sa|mia|sua|ta|tua) ){0,2}(?:voce|voix)
    narrate|read (?:it|this) (?:aloud|out loud)|seslendir\w*|vertonen|vorlesen
    (?:generate|create|make|render|produce|animate) (?:[^ \n]+ ){0,4}?(?:images?|pictures?|photos?|art|portraits?|shots?|clips?|videos?|animations?|songs?|music|voiceovers?|speech|audio)
    fine[- ]?tun\w*|finetun\w*|feintun\w*|train|training|trainier\w*|entrenar|treinar|egit\w*
    ince ayar\w*|ajuste fino|generar|gerar|generieren|erzeugen|olustur\w*|uret\w*|animar
    upscal\w*|inpaint\w*|chat with (?:it|the model|a model|llama|[a-z]+ \d+b)
    (?:strip|separate|isolate|remove|split|extract|pull)\w* (?:out )?(?:the )?(?:\w+ )?(?:vocals|stems|instrumentals?|drums|backing tracks?)
    (?:make|let|have|get) (?:my |the |this )?(?:computer|mac|laptop|pc|machine) (?:talk|speak|read)\w*
`);

export const local = family(String.raw`
    locally|local|offline|self[- ]?host\w*|my own (?:gpu|hardware|machine)
    on (?:my|this|the) (?:own )?(?:machine|laptop|computer|mac|macbook(?: air| pro)?|pc|desktop|box|rig|workstation|gpu|hardware|disk|ssd)
    on my (?:m[1-5]\w*|rtx ?\d+|\d{4}|\d+ ?gb\w*)|on this (?:mac|laptop|machine|box)
    yerel\w*|lokal\w*|bilgisayar\w*|makine(?:m|mde|me|mi)\w*
    en local|localmente|en mi (?:pc|mac|maquina|ordenador|computadora|portatil|laptop|equipo)
    no meu (?:pc|mac|computador|notebook)|na minha maquina
    auf meine\w* (?:rechner|computer|laptop|pc|mac|maschine)|bei mir lokal
    sur (?:mon|ma) (?:pc|mac|ordinateur|portable|laptop|machine)|in locale|sul mio (?:pc|mac|computer|portatile)
`);

/* Heavy local AI */

export const aiName = family(String.raw`
    xtts\w*|coqui|f5[- ]?tts|e2[- ]?tts|kok[oe]ro|piper[- ]?tts|styletts2?|openvoice|parler[- ]?tts
    chatterbox|orpheus[- ]?tts|csm[- ]?1b|dia[- ]?1\.6b|nari[- ]?labs|zonos|fish[- ]?speech
    spark[- ]?tts|vibevoice|higgs[- ]?audio|index[- ]?tts\w*|cosyvoice\w*|melo[- ]?tts
    qwen3?[- ]?tts|tortoise[- ]?tts|gpt[- ]?sovits|rvc|so[- ]?vits\w*|applio|alltalk|suno[- ]bark
    stab(?:le|el)[- ]?dif{1,2}u?s{1,2}i?on|sd ?1\.5|sdxl|sd ?3(?:\.5)?|flux[.-]?[12](?:\.\d)?(?:[- ](?:dev|schnell|klein|kontext|pro))?
    flux[- ](?:dev|schnell|kontext|klein)|co[mn]f[iy] ?ui|automatic ?1111|a1111|sd[- ]?webui|sd[- ]forge
    forge webui|webui forge|fooocus|invoke ?ai|qwen[- ]?image|z[- ]image|hidream|kohya\w*
    controlnet|civitai|txt2img|img2img|real[- ]?esrgan|diffusers
    wan ?2\.\d|hunyuan ?video|ltx[- ]?(?:video|2(?:\.\d)?)|cogvideo\w*|mochi[- ]?1|animatediff
    stable video diffusion|svd[- ]xt|framepack|wav2lip|sadtalker|liveportrait|facefusion|roop
    deep[- ]?live[- ]?cam|open[- ]?sora
    ol{1,2}am{1,2}a|l{1,2}ama[.-]?cpp|llamafile|lm ?studio|text[- ]generation[- ]webui|oobabooga|koboldcpp|vllm
    sglang|text[- ]generation[- ]inference|exllama\w*|gguf|ggml|mlx(?:[- ]lm)?|gpt4all
    (?:llava|qwen|mixtral|deep[- ]?seek|codellama|nemotron|gpt[- ]oss|starcoder|vicuna)(?:[- ]?(?:r|v|coder)?\d+(?:\.\d+)?)?(?:[- :]?\d+(?:\.\d+)?b)?
    (?:llama(?![- ]?index)|lama|mistral|gemma)[- ]?(?:r|v|coder)?\d+(?:\.\d+)?(?:[- :]?\d+(?:\.\d+)?b)?
    (?:phi|yi|granite|olmo)[- ]?[1-9](?:\.\d+)?(?:[- :]?\d+(?:\.\d+)?b)?|falcon[- ]?(?:\d+(?:\.\d+)?b|[1-3](?:\.\d+)?(?:[- :]?\d+(?:\.\d+)?b)?)
    (?:whisper|wisper|whipser)(?:x|\.cpp|[- ]large\w*|[- ]v?\d)|faster[- ]whisper|distil[- ]whisper|insanely[- ]fast[- ]whisper
    parakeet|nvidia canary|wav2vec2?|vosk|pyannote
    musicgen|audiocraft|stable audio|riffusion|ace[- ]step|diffrhythm|audioldm|demucs|uvr5?
    yolov?\d+\w*|ultralytics|detectron2|mmdetection|segment anything|sam ?2|nanogpt|dreambooth
    textual inversion|unsloth|axolotl|deepspeed|torchrun|accelerate launch|fluxgym|ai[- ]toolkit
`);

// Names that are also ordinary words or people, counted only next to AI vocabulary
export const aiWeakName = family(String.raw`
    bark|piper|flux|forge|orpheus|sesame|krea|whisper|llama|gemma|mistral|wan ?2
`);

export const aiContext = family(String.raw`
    tts|text[- ]to[- ]speech|voices?|speech|images?|video|models?|weights|checkpoints?|lora
    diffusion|ai|llm|gpu|vram|audio|mp3s?|wavs?|m4a|recordings?|podcasts?|transcri\w*|transkri\w*
    subtitles?|lectures?|interviews?|ollama|gguf|quantiz\w*|locally|local|offline|lokal\w*|yerel\w*
    localmente|en local|\d+(?:\.\d)? ?b|kayit\w*|kayd\w*|grabacion\w*|aufnahme\w*|gravac\w*
`);

// A model name followed by these is code that calls the model, not the model run locally
export const integrationAfter =
    /^(?:[- ][\w.-]+)?[- ](?:api|provider|adapter|client|sdk|integration|wrapper|endpoint|connector|plugin|keys?)s?(?![a-z])/;

export const aiTask = family(String.raw`
    text[- ]to[- ](?:speech|image|video|music|audio)|image[- ]to[- ](?:video|image)|speech[- ]to[- ]text
    tts|stt|voice ?(?:clone|cloner|cloning|changer|conversion|model)|ai voice|ai cover|voice ?over\w*
    stem separation|vocal (?:removal|remover|isolation|separation)|(?:separate|isolate|strip)\w* (?:out )?(?:the )?vocals
    audiobook|sesli kitap|texto a voz|sintesis de voz|clonacion de voz|clonagem de voz|text[- ]?zu[- ]?sprache
    sprachsynthese|stimmklon\w*|ki[- ]?stimme|horbuch|sintesi vocale|synthese vocale
    (?:ai|open[- ]source|local|diffusion) (?:image|video|art|music|voice|speech) (?:model|generator|generation)
    (?:image|video|music) (?:generation|generator|diffusion) model|(?:generative|diffusion|text[- ]to[- ]\w+) (?:image |video )?model
    local (?:llm|model|ai|chatgpt|gpt|language model)|self[- ]host(?:ed)? (?:llm|model|ai)|(?:llm|model) locally
    yerel (?:bir )?(?:llm|model|yapay zeka|dil modeli)|lokal\w* (?:llm|modell|sprachmodell|ki)
    (?:llm|modelo) (?:en )?local|ia local|modelo local
    fine[- ]?tun\w*|finetun\w*|feintun\w*|q?lora|ince ayar\w*|ajuste fino
    (?:entrenar|treinar|trainier\w*|egit\w*) (?:un |uma |ein |mein |mi )?(?:modelo|model\w*|lora|voz|stimme)
    (?:model|lora|ses)\w* egit\w*|train (?:a |an |my |the )?(?:\w+ )?(?:model|lora|network|classifier|detector|gpt|llm|transformer|language model|neural net\w*|gan|vae) (?:from scratch|on)
    transcri(?:be|bing|ption|pt)\w*|transkri\w*|desifre\w*|diariz\w*
    upscal\w*|inpaint\w*|lip ?sync\w*|talking head|face ?swap\w*|deepfake\w*|yuz degistir\w*
    intercambio de caras|gesichtstausch
    (?:generar|crear|gerar|criar|animar) (?:\w+ ){0,2}?(?:imagenes|imagens|fotos|video|videos|ilustraciones)
    (?:imagenes?|imagens?|videos?) con ia|(?:bilder?|video) (?:\w+ )?(?:generieren|erzeugen|erstellen)
    (?:resim|gorsel|video)\w* (?:olustur|uret)\w*|yapay zeka (?:ile )?(?:resim|gorsel|video|ses)\w*
`);

// Voice cloning runs as a local model unless a hosted API is named, so it counts without a model name
export const voiceClone = family(String.raw`
    clon\w* (?:my |a |his |her |their |this |the |someone'?s |our )?(?:own )?(?:\w+ )?voices?|cloned voices?|voice ?clon\w*
    (?:my|his|her|their|a) voice (?:as|for) (?:a |an )?(?:tts|voice ?over|narrat\w*)
    clon(?:ar|a|e) (?:mi |la |su |minha |sua )?voz|klon\w* (?:meine |die |seine )?stimme|ses(?:imi|ini|i)? klon\w*
    (?:meine|die|seine|ihre) stimme (?:zu )?klon\w*|(?:mi|tu|su|minha|sua) voz clonad[ao]
    clon\w* (?:(?:la|ma|sa|mia|sua|ta|tua) ){0,2}(?:voce|voix)
`);

// A chat assistant that runs on the user's own hardware, the local twin of a hosted chatbot
export const localAssistant = family(String.raw`
    (?:private|offline|local|self[- ]?hosted|personal) (?:ai |chat ?|llm |gpt )?(?:assistant|chatbot|chat ?gpt|gpt|llm|copilot)
    (?:chatgpt|gpt|claude|copilot|perplexity|gemini)[- ]?(?:like|style|alternative|clone|replacement)
    (?:assistant|chatbot|chat ?gpt|llm) (?:\w+ ){0,3}?(?:on|in) my (?:own )?(?:computer|machine|laptop|mac|pc|hardware|server)
`);

export const videoName = family(String.raw`
    wan ?2\.\d|hunyuan ?video|ltx[- ]?(?:video|2)|cogvideo\w*|mochi[- ]?1|animatediff
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

// Things a person can hand over that run as code, so a client sending a bug report does not count
const codeNoun = String.raw`(?:repo|repos|repository|script|scripts|(?<!(?:csv|json|pdf|data|log|text|config|excel|word|design|figma|image|video|audio) )files?|binary|binaries|tool|tools|bot|bots|exe|executable|zip|archive|app|apk|dmg|msi|installer|program|plugin|extension|package|mod|mods|patcher|crack|cheat|hack|cli|one[- ]liner|take[- ]home|mcp server|\w[\w-]{0,40}\.(?:exe|zip|rar|7z|apk|dmg|pkg|app|msi|jar|sh|py|js|ps1|bat))(?![a-z0-9_])`;

const person = String.raw`(?:an? |my |some |this |that |the |random )?(?:random )?(?:friend|buddy|mate|cousin|brother|sister|someone|somebody|some ?one|guy|dude|stranger|recruiter|client|vendor|person|user(?!s)|redditor|youtuber|streamer|seller|account|anon|interviewer|hiring manager|headhunter|employer)s?(?! (?:on|from|in|at) (?:my|our) (?:team|company|org|work|office|department))`;

const handed = String.raw`(?:sent|sends|send|shared|shares|gave|gives|linked|links|dropped|drops|posted|posts|dm'?d|dmed|messaged|emailed|uploaded|recommended|recommends|passed|forwarded|handed)`;

// Where strangers post code
const place = String.raw`(?:reddit|subreddit|discord|telegram|youtube|tiktok|twitter|tweet|x\.com|forum|forums|hacker news|4chan|facebook|instagram|whatsapp|pastebin|gist|medium|blog|random (?:site|website|page)|website|video|livestream|stream|group chat|channel|thread|comments?|dms?|github|gitlab)`;

const pronoun = String.raw`(?:this|it|these|them|that)(?= *(?:$|[\n,.!?:;]|(?:on|over|via|in|from|earlier|yesterday|today|last|and|but|to|so|which|for)(?![a-z])))`;

const handedObject = String.raw`(?: (?:me|us|him|her|them))?(?: (?:${pronoun}|(?:(?:a|an|the|this|that|these|those|their|his|her|some|over|along) )?(?:link to (?:(?:a|an|the|this|their|his|her|some) )?)?(?:[\w'.-]{1,40} ){0,3}?${codeNoun}))`;

// Code that reached the user from someone else, and the place or person it came from
export const origin = family(String.raw`
    ${person}\b[^\n.?!]{0,40}?\b${handed}${handedObject}
    (?:this|that|the|a|an|some|these) (?:[\w'.-]{1,40} ){0,3}?${codeNoun} (?:that |which )?(?:i |we )?(?:got |received )?(?:from )?${person}[^\n.?!]{0,30}? ${handed}
    ${codeNoun} (?:[\w'.-]{1,40} ){0,2}?(?:from|by) ${person}
    (?:found|saw|seen|got|spotted|came across|stumbled (?:on|upon|across)|downloaded|grabbed|picked up) (?:${pronoun}|(?:a|an|the|this|that|some) (?:[\w'.-]{1,40} ){0,3}?${codeNoun})(?: [\w'.-]{1,40}){0,4}? (?:on|in|at|from|via|off) (?:a |an |the |some |this )?(?:[\w'.-]{1,40} ){0,2}?${place}
    ${codeNoun} (?:that |which )?(?:i |we |someone |somebody |a guy |some guy )?(?:found|saw|seen|got|spotted|came across|downloaded|grabbed|posted|shared|linked|dropped)(?: it)? (?:on|in|at|from|via|off) (?:a |an |the |some |this )?(?:[\w'.-]{1,40} ){0,2}?${place}
    ${codeNoun} (?:from|off|via) (?:a |an |the |some |this |that )?(?:[\w'.-]{1,40} ){0,2}?${place}
    ${codeNoun} (?:[\w'.-]{1,40} ){0,3}?(?:that |which )?(?:supposedly|apparently|allegedly|claims? to|claiming to|promises to|promising to|is supposed to|swears it)
    take[- ]home|coding (?:test|challenge|assignment|exercise)|interview (?:task|project|assignment|test)
    tech(?:nical)? (?:test|assessment)
    (?:reddit|discord|telegram|youtube|tiktok|twitter|forum|eksi|instagram|github)\w*'?(?:te|ta|de|da|ten|tan|den|dan|deki|daki)\b[^\n.?!]{0,40}?(?:buldum|gordum|rastladim|paylas\w*|atti\w*|gonder\w*|yolla\w*|indir\w*|onerdi\w*|verdi\w*)
    (?:arkadasim|biri|birisi|kuzenim|ise alimci|musteri|tanimadigim biri)\w* [^\n.?!]{0,30}?(?:repo|script|program|arac|uygulama|dosya|exe|zip|bot|link|baglanti|kod|hile)\w* [^\n.?!]{0,20}?(?:gonderdi|atti|yolladi|paylasti|verdi)
    (?:mulakat|ise alim|case|teknik) (?:odevi|gorevi|projesi|testi)
    (?:lo |la )?(?:encontre|vi|baje|descargue) en (?:\w+ ){0,2}?(?:reddit|discord|telegram|youtube|tiktok|twitter|un foro|foro)
    en (?:un |el )?(?:foro|reddit|discord|telegram|youtube|tiktok) (?:\w+ ){0,2}?(?:encontre|vi|me pasaron|pasaron|compartieron|subieron)
    me (?:lo |la )?(?:mando|paso|envio|compartio|dio|recomendo) (?:un amigo|una amiga|mi amig[oa]|alguien|un desconocido|un reclutador|un cliente|mi primo|un tipo)
    (?:un amigo|una amiga|mi amig[oa]|alguien|un desconocido|un reclutador|un cliente|mi primo|mi herman[oa]|un tipo)(?: (?:de|en) \w+)? (?:me |nos )?(?:mando|paso|envio|compartio|dio|recomendo) (?:un |una |el |la |este |esta |esto |lo )?(?:\w+ ){0,2}?(?:repo|repositorio|script|programa|herramienta|bot|archivo|ejecutable|exe|zip|app|aplicacion|instalador|extension|codigo|enlace|link)
    (?:script|repo|programa|herramienta|bot|archivo|codigo|app) (?:que )?(?:encontre|vi|baje|descargue|pasaron|compartieron) en (?:un |una |el |la )?(?:\w+ )?(?:foro|reddit|discord|telegram|youtube|tiktok)
    me (?:pasaron|mandaron|enviaron|compartieron|dieron|recomendaron) (?:un |una |el |la |este |esta |esto )?(?:\w+ ){0,2}?(?:repo|repositorio|script|programa|herramienta|bot|archivo|ejecutable|exe|zip|app|aplicacion|instalador|extension|codigo|enlace|link)
    (?:repo|repositorio|script|programa|herramienta|bot|archivo|app|aplicacion) (?:[\w-]+ ){0,4}?que (?:promete|supuestamente|dice que|asegura)
    prueba tecnica|ejercicio de (?:entrevista|seleccion)|reclutador
    (?:auf|bei|in) (?:\w+ )?(?:reddit|discord|telegram|youtube|tiktok|twitter|einem forum|forum) (?:gefunden|gesehen)
    (?:ein freund|eine freundin|ein kumpel|jemand|ein fremder|ein recruiter|ein kunde)[^\n.?!]{0,40}?(?:skript|script|programm|tool|repo|datei|exe|zip|bot|app|link|installer|code|das|es|dies)\b[^\n.?!]{0,30}?(?:geschickt|gesendet|geteilt|gegeben|empfohlen)
    (?:probe|test|bewerbungs)aufgabe|vorstellungsgesprach
    (?:achei|vi|encontrei|baixei) (?:um |uma |esse |essa |este |esta |isso |isto )(?:\w+ ){0,2}?(?:no|num|na|numa|em um|em uma|do|da) (?:\w+ ){0,2}?(?:youtube|reddit|discord|telegram|tiktok|twitter|forum)
    (?:um amigo|uma amiga|alguem|meu primo|um recrutador|um desconhecido)[^\n.?!]{0,30}?(?:mandou|enviou|passou|compartilhou) (?:um |uma |o |a |esse |essa |este |isso |isto )?(?:\w+ ){0,2}?(?:repo|repositorio|script|programa|ferramenta|bot|arquivo|executavel|exe|zip|app|aplicativo|instalador|extensao|codigo|link)
`);

const paidApp = String.raw`(?:photoshop|office|windows|adobe|fl studio|capcut|autocad|premiere|illustrator|lightroom|after effects|matlab|ableton|vegas|corel|spotify|netflix|youtube)`;
const aiApp = String.raw`(?:claude code|claude|copilot|cursor|chatgpt|sora|kling|seedance|midjourney|elevenlabs|voicemod)`;
const game = String.raw`(?:roblox|valorant|fortnite|cs2|csgo|counter[- ]strike|apex legends|warzone|gta|pubg|tarkov|overwatch|r6|dota|genshin|free fire|minecraft|rust|apex|cod)`;

// Each entry names a lure outright, so free, unlock, patch or a game name alone never counts
export const lure = family(String.raw`
    cracked (?:[\w.-]+ ){0,2}?(?:version|apk|exe|games?|software|apps?|copy|build|installer|plugins?|vsts?|accounts?|client|launcher|edition|release)s?
    keygen|serial key|activator|kms ?pico|kms ?auto|pirated|warez|nulled|unlocker
    crack(?:s)? (?:for|of|version|download|setup|apk|exe|patch)
    free (?:\w+ )?(?:nitro|robux|v-?bucks|followers|likes|vip|premium)(?! (?:trial|tier|plan|plans|features?|period|month|week|users?|members?))
    (?:get|unlock|activate|gives?|giving)\w* (?:\w+ ){0,3}?(?:premium|pro|plus|vip) (?:\w+ ){0,2}?(?:for free|free|without paying|for nothing|gratis)
    bypass (?:the )?(?:paywall|license|licensing|activation|drm|anti[- ]?cheat)|(?:license|licensing|activation|drm) (?:bypass|crack|patch)
    mod menu|aimbot|wallhack|wall hack|esp hack|triggerbot|spoofer|hwid (?:spoof\w*|ban\w*)|dll inject\w*|cheat engine
    game (?:hacks?|trainers?|cheats?)|auto[- ]?farm\w*|auto[- ]?clicker
    inject\w* (?:\w+ ){0,2}?into (?:the |a )?(?:running )?(?:game|process)
    (?:crack|cracked|keygen|activator)\w*\b[^\n]{0,30}?\b(?:${paidApp}|${game})(?![a-z])
    ${paidApp}[^\n]{0,20}?\b(?:crack|cracked|keygen|activator|kirik|crackeado|craqueado)\w*
    ${paidApp} (?:premium |pro |plus )?(?:patcher|unlocker|mod apk)
    (?:unlock|desbloque|freischalt|desbloquei)\w* (?:\w+ ){0,3}?(?:premium|pro|plus|vip)\b[^\n]{0,30}?\b${paidApp}(?![a-z])
    ${game} (?:\w+ )?(?:cheats?|hacks?|aimbot|executor|injector|mod menu|trainer|unlocker|spoofer)
    (?:nitro|robux|token|account|gift ?card|v-?bucks) (?:gen|generator)|token (?:grabber|logger|stealer)
    stealer|remote access trojan|rat (?:builder|client|panel|tool)
    (?:wallet|seed phrase|seed|mnemonic|private key) (?:recover\w*|finder|cracker|checker|drainer|brute\w*)
    drainer (?:script|kit|bot|contract|code|tool|repo|app|link|site)s?|(?:crypto|token|nft|solana|sol|eth)[- ]?drainer
    (?:recover|find|brute ?force|crack)\w* (?:\w+ ){0,3}?(?:seed phrase|mnemonic|wallet)
    airdrop (?:claim\w*|bot|farmer|farming|hunter|checker)|claim\w* (?:\w+ ){0,2}?airdrop
    (?:sniper|mev|sandwich|arbitrage|arb|pump|copy[- ]?trade|copytrade|volume|memecoin|crypto|forex|trading) (?:\w+ )?bots?
    (?:instagram|insta|tiktok|youtube|twitter|twitch|spotify|discord|kick) (?:\w+ )?(?:views?|viewers?|follows?|followers?|likes?|likers?|subs|subscribers?|streams?|listeners?|plays?|comments?|members?|engagement) ?(?:bot|booster|farm\w*|gen\w*)
    (?:view|viewer|follower|like|follow|subscriber)s? ?(?:bot|booster)|captcha (?:solver|bypass)
    (?:leaked|cracked|jailbroken)\b[^\n]{0,30}?\b${aiApp}
    ${aiApp} (?:premium|pro|plus|max|ultra) (?:\w+ ){0,2}?(?:for free|free|without paying|for nothing|unlocked|crack\w*|keygen)
    free ${aiApp} (?:premium|pro|plus|max|ultra|accounts?|licen[cs]es?|keys?|subscriptions?|access)
    leaked (?:source|build|version|code|model)|uncensored (?:image|model|generator|ai)
    hile(?:si|sini|ler|leri|lerini|li|yi|ye|de|den)?|kirik (?:surum|program)\w*|korsan\w*|lisans (?:anahtari|kirma)\w*
    (?:bedava|ucretsiz) (?:nitro|robux|vp|vbucks|takipci|begeni|lisans|premium|pro)\w*|hesap (?:botu|calma)
    kripto (?:bot|cuzdan)\w*|cuzdan (?:kurtar|bul)\w*|takipci (?:botu|hilesi|bot)|sizdiril\w*
    trucos? (?:para|de) (?:juego|valorant|fortnite|roblox)|crackead[oa]|(?:version|copia|juego|programa|software|app|aplicacion|apk|jogo|versao|windows|office|photoshop) pirata|activador|licencia gratis
    gratis (?:premium|nitro|robux|pavos)|(?:robux|nitro|pavos|v-?bucks) gratis|generador de (?:nitro|robux|cuentas)
    bot de (?:trading|cripto|seguidores)|recuperar (?:billetera|cartera|frase semilla)
    (?:version|codigo|modelo|build|cuentas?) filtrad[oa]s?
    raubkop\w*|aktivator|kostenlos\w* (?:premium|pro|nitro|robux|lizenz|vollversion)|vollversion gratis
    generator fu(?:e)?r (?:nitro|robux)|krypto[- ]?(?:bot|wallet)|trading[- ]?bot|wallet (?:wiederherstell\w*|knacken)
    geleakt\w*|craqueado|ativador|gerador de (?:robux|nitro)|hack\w* (?:de|pra|para) (?:minecraft|roblox|free fire)
    (?:premium|pro|plus|vip) (?:de graca|gratis|gratuito|kostenlos|bedava|ucretsiz)
`);

export const ownBefore =
    /(?:^|[\s(])(?:my|our|mine|mi|mis|meu|minha|nosso|benim|kendi|mein\w*|unser\w*|nuestro)\s(?:\S+\s){0,2}$/;

export const createBefore =
    /(?:build|write|create|make|code|develop|implement|scaffold|program)\s(?:me\s)?(?:a|an|my|our|the)\s(?:\S+\s){0,2}$/;

export const poc = family(String.raw`
    exploits?|exploit code|cve-\d{4}-\d{3,7}|0[- ]?day|zero[- ]?day|rce|privesc
    lpe|reverse shell|bind shell|shellcode|msfvenom|metasploit|exploit'?\w*
`);

export const pocWeak = family(String.raw`
    pocs?|proof[- ]of[- ]concept
`);

// What an exploit attacks, so a proof of concept for a flaw differs from one for a feature
export const flaw = family(String.raw`
    cve\w*|vuln\w*|security (?:bug|flaw|hole|issue|advisory)|bug bounty|rce|privesc|lpe
    (?:buffer|heap|stack|integer) overflow|\w+ injection|use[- ]after[- ]free|zero[- ]?day|0[- ]?day
    payloads?|shellcode|(?:the|this|that|a|an|new) (?:[\w.-]+ ){0,2}?(?:bug|flaw)
    zafiyet\w*|guvenlik acig\w*|vulnerabilidad\w*|vulnerabilidade\w*|schwachstelle\w*|sicherheitslu(?:e)?cke\w*
`);

// An exploit run, built or aimed somewhere, as opposed to a glitch players talk about
export const exploitUse = family(String.raw`
    (?:run|runs|running|execute|exec|launch|try|test|compile|build|clone|download|fire|use|pull|grab|fetch)\w* (?:[\w.'-]+ ){0,4}?exploits?
    exploits? (?:code|script|scripts|binary|repo|chain|kit|against|on (?:my|our|the|a)|for (?:cve|the|this|that))
    (?:ejecut|corr|prueb|lanz|compil|clon|descarg|ausfu(?:e)?hr|start|rod|execut|calistir|dene|derle|indir)\w* (?:[\w.'-]+ ){0,4}?exploit\w*
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

// Code that arrived by email without a file name, as in a script sent as an attachment
export const mailed = family(String.raw`
    (?:e-?mail|mail|message|inbox)(?:ed)? (?:\w+ ){0,2}?attachments?|attachments? (?:from|in|of) (?:an? |the |some )?(?:\w+ ){0,2}?(?:e-?mails?|mail|messages?|sender|stranger)
    (?:as|in) an? (?:e-?mail )?attachment|(?:came|arrived|sent|got) (?:\w+ ){0,2}?(?:by|via|over|in an?) e-?mail
    e-?mail(?:ed)? (?:me|us) (?:an? |the |this |some )?(?:\w+ ){0,2}?(?:scripts?|programs?|exe|binar(?:y|ies)|installers?|executables?|apps?)
    adjunto (?:de|en|del) (?:un |el )?correo|anhang (?:einer|der|aus der) (?:e-?mail|mail)|anexo (?:de|do|no) (?:um |o )?e-?mail
    e-?posta eki\w*|mailde(?:ki)? ek\w*
`);

export const codeKind = family(String.raw`
    scripts?|programs?|exe|executables?|binar(?:y|ies)|installers?|javascript|js|python|powershell
    macros?|apk|payloads?|skript|programm|programa|ejecutable|executavel
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
    (?:don'?t|dont|do not|not sure i) trust
    (?:untrusted|sketchy|shady|suspicious|dodgy|fishy|obfuscated|unknown) (?:[\w.'-]+ ){0,2}?(?:code|scripts?|repos?|repository|binar(?:y|ies)|files?|exe|executables?|programs?|apps?|apk|packages?|installers?|links?|urls?|attachments?|tools?|extensions?|plugins?|zip|archives?|downloads?|dll|macros?|javascript|js|python|powershell|commands?|one[- ]liners?|payloads?|dependenc(?:y|ies)|source|senders?|emails?)
    (?:looks?|seems?|is|feels?|kinda|kind of|a bit|very|pretty|super|bit|smells?) (?:\w+ )?(?:sketchy|shady|suspicious|dodgy|fishy)
    guvenli mi|zararli mi|virus(?:lu)? (?:mu|var mi)|kotu amacli|guvenilir mi|guvenmiyorum
    es seguro|es (?:un )?virus|es malware|es (?:una )?estafa|es confiable|no confio|parece sospechos[oa]
    (?:archivo|script|programa|repo|repositorio|enlace|link|exe|adjunto|codigo|ejecutable|app) (?:\w+ )?sospechos[oa]
    ist (?:das|es) sicher|schadsoftware|ist das malware|vertrauenswu(?:e)?rdig|(?:sieht|wirkt) (?:\w+ )?verdachtig
    verdachtig\w* (?:datei|skript|script|programm|repo|link|exe|anhang|code|tool|app)
    e seguro|nao confio|parece suspeit[oa]
    (?:arquivo|script|programa|repo|link|exe|anexo|codigo|executavel|app) (?:\w+ )?suspeit[oa]
    supheli (?:dosya|script|program|link|exe|ek|kod|uygulama)\w*
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
    izole (?:bir )?ortam\w*|gecici (?:bir )?(?:sunucu|makine|ortam)\w*|bulut\w* gpu\w*
    (?:sanal makine|kum ?havuzu|uzak (?:bir )?sunucu|bulut (?:sunucu|makine))\w*(?:da|de|ta|te|ya|ye|a|e)\b[^\n]{0,30}?\b(?:calistir|dene|kur|test et|yukle|derle)\w*
    entorno aislado|maquina (?:virtual )?desechable|gpu en la nube|ambiente isolado|gpu na nuvem
    (?:ejecut|corr|prueb|lanz|abr|instal|compil|arranc|rod|execut)\w* (?:[^ \n]+ ){0,8}?(?:en|dentro de|em|numa?|na) (?:una? |el |la |uma )?(?:sandbox|vm|maquina virtual|caja de arena|servidor remoto|entorno (?:aislado|temporal)|ambiente (?:isolado|temporario))
    isoliert\w* umgebung|wegwerf\w*
    (?:in|auf) (?:einer |einem |der |dem )?(?:sandbox|vm|virtuelle\w* maschine|entfernte\w* (?:server|maschine))\b[^\n]{0,30}?\b(?:ausfu(?:e)?hr|laufen|start|test|instal|probier)\w*
    (?:fu(?:e)?hr|lass|start|teste|installier|probier)\w* [^\n]{0,40}?(?:in|auf) (?:einer |einem |der |dem )?(?:sandbox|vm|virtuelle\w* maschine)
`);

// Payment, app store, CRM and browser sandboxes are not requests for an isolated machine
export const notIsolation = family(String.raw`
    iframe|stripe|paypal|braintree|plaid|adyen|square|razorpay|mollie|klarna|checkout|payments?|merchant
    odeme\w*|iyzico|paytr|sanal pos|pagos?|pasarela|pagamentos?|zahlung\w*
    testcontainers|test ?containers?|per test|each test|for each test|test fixtures?|in ci
    test (?:cards?|card numbers?|mode|merchants?|accounts?|users?)|card numbers?|credit cards?
    in-app purchases?|iap|storekit|app store|testflight|google play|play console|ios build|android build
    salesforce|apex|sfdx|scratch orgs?|crm|hubspot|zoho|netsuite|shopify|ebay|amazon pay|twilio|docusign|coinbase
    sandbox (?:attribute|attr|flag|mode|accounts?|keys?|credentials|api|url|domain|orgs?|tenant|instance|users?|testers?|store)
`);

export const notMine = family(String.raw`
    (?:don'?t|dont|do not|rather not|would rather not|wouldn'?t|won'?t|never) (?:want|wanna|need|like|trust)[^\n]{0,50}?(?:on|in|onto|near|to touch) (?:my|this) (?:own )?(?:machine|laptop|computer|mac|macbook|pc|system|box|disk|drive|ssd|host)
    (?:anywhere |somewhere |remotely )?near my (?:machine|laptop|computer|mac|macbook|pc|system|files)
    (?:keep|stay) (?:it |this |that )?(?:off|away from) my (?:machine|laptop|computer|mac|pc|system)
    (?:instead of|outside(?: of)?|away from|other than|that isn'?t|that is not) (?:on )?my (?:own )?(?:machine|laptop|computer|mac|macbook|pc|system|box)
    (?:run|test|try|execute|install|do|put|build|open|detonate)(?:ning|ing)? (?:it|this|that|them|these|those|the|an?|my|our)\b[^\n]{0,50}?(?:not on|isn'?t|is not|never on) (?:on )?my (?:own )?(?:machine|laptop|computer|mac|macbook|pc|system|box)
    (?:run|test|try|execute|install|do|put|host|detonate)(?:ning|ing)? (?:[^ \n]+ ){0,4}?(?:(?:somewhere|someplace) (?:else|safe|isolated)|elsewhere)
    (?:run|test|try|execute|install|build|open|detonate|do|put)(?:ning|ing)? (?:[^ \n]+ ){0,4}?(?:on|in|onto) (?:some |an? )?(?:other|another|different|separate|second|spare|someone else'?s) (?:computer|machine|box|pc|laptop|system|host)
    (?:bilgisayarim|makinem|laptopum|sistemim)\w*[^\n]{0,40}?(?:kurmak istemiyorum|calistirmak istemiyorum|bulasmasin|bozul\w*|kirlen\w*|zarar\w*)
    baska bir (?:makine|yer|bilgisayar|sistem)\w* [^\n]{0,30}?\b(?:calistir|dene|kur|test et|yukle)\w*
    no quiero (?:instalar|ejecutar|correr|tener)\w*[^\n]{0,30}?en mi (?:pc|computadora|ordenador|maquina|portatil|laptop|mac|sistema)
    (?:ejecut|corr|prueb|instal|lanz|hac|pon)\w* (?:[^ \n]+ ){0,4}?en otro (?:lado|sitio|equipo|ordenador|pc|lugar)
    en otro (?:lado|sitio|equipo|ordenador) (?:[^ \n]+ ){0,2}?(?:ejecut|corr|prueb|instal)\w*|fuera de mi (?:pc|maquina|ordenador)
    nicht auf meine\w* (?:rechner|computer|laptop|pc|mac|system)
    (?:fu(?:e)?hr|lass|instal|test|probier|start)\w* (?:[^ \n]+ ){0,4}?woanders|woanders (?:[^ \n]+ ){0,3}?(?:ausfu(?:e)?hr|laufen|instal|test|probier|start)\w*
    nao quero (?:instalar|rodar|executar)[^\n]{0,30}?(?:no meu|na minha)|fora do meu (?:pc|computador)
    (?:rod|execut|instal|test)\w* (?:[^ \n]+ ){0,4}?em outr[oa] (?:lugar|computador|pc|maquina)
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
    (?:precisa|requer|necesita|requiere|braucht|benotigt|gerektir\w*)\b[^\n]{0,30}?\b(?:cuda|nvidia)
    (?:so|solo|nur|sadece|apenas) (?:funciona|roda|corre|funktioniert|lauft|calisir)\w*\b[^\n]{0,30}?\b(?:cuda|nvidia)
    (?:cuda|nvidia)[- ]only|cupy|numba\.cuda|flash[-_ ]?attn\w*|flash[- ]attention|xformers|bitsandbytes|triton|tensorrt
    vllm|exllamav2|auto[- ]gptq|mamba[- ]ssm|nvidia[- ]container[- ]toolkit
`);

export const rawDevice = family(String.raw`
    /dev/(?:sd[a-z]|nvme\d|disk\d|hd[a-z]|mmcblk\d)
`);

// Work aimed at a machine the user already runs elsewhere, or at CI
export const remoteTarget = family(String.raw`
    (?:on|in|to|onto|into) (?:the|our|my|a|an|this|that) (?:\w+ )?(?:server|servers|vps|ec2|droplet|cluster|k8s|kubernetes|pod|runpod|colab|kaggle|lambda|homelab|nas|raspberry pi|ci|ci runner|hosts?|instances?|bastion|fleet)
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
    so (?:funciona|roda|rodam|funcionam|existe|compila)\w* (?:\w+ ){0,2}?(?:em |no )?linux
    ebpf|bpftrace|bcc tools|io_uring|systemd|systemctl|apt(?:-get)?|kvm|lxc|cgroups?|ip netns|nftables|iptables
    linux'?(?:ta|te|da|de)|linux binar\w*
`);

// Config written for a Linux tool, which runs on the server it is written for
export const linuxConfigAfter =
    /^[ -](?:(?:service|unit|timer|socket|sources?) )?(?:files?|units?|rules?|config\w*|configuration|polic(?:y|ies)|profiles?|chains?|manifests?|templates?|definitions?)(?![a-z])/;

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
    (?:instal\w*|updat\w*|upgrad\w*|set ?up|kur\w*) (?:the )?(?:nvidia|cuda|gpu|graphics) (?:drivers?|toolkit)
    (?:(?:nvidia|cuda|gpu|graphics)[- ](?:card )?)+(?:drivers?|toolkit)|drivers? for (?:my |the |an? )?(?:nvidia|gpu|graphics)
    kernel modul\w*|dkms|out[- ]of[- ]tree (?:driver|module)|custom kernel|kernel patch\w*
`);

/* Experiments that can break the machine */

export const destructive = family(String.raw`
    rm -[a-z]{0,6}r[a-z]{0,6} (?:--no-preserve-root )?(?:/|~|\$home|/\*|/usr|/etc|/bin|/var|/system)(?=\s|$)
    dd(?:[- ]based)? [^\n]{0,40}?(?:/dev/|disk|drive|ssd|speed test)
    mkfs\w*|wipefs|wipe (?:the |my )?(?:disk|drive|ssd|partition)|format (?:the |my )?(?:disk|drive|ssd|partition|c:)
    fork ?bomb|(?:cause|trigger|force|induce|provoke|invoke)\w* (?:a |the )?(?:kernel panic|oom(?: killer)?)|break (?:my|the) (?:system|machine|os|install)
    (?:delet|remov|wip|eras)\w* (?:\w+ ){0,3}?(?:every (?:file|folder|directory)|all (?:the )?(?:files|folders|directories|data)|everything)\b[^\n]{0,30}?(?:under|in|from|on|of) (?:/|~|\$home|(?:my|the) (?:whole |entire )?(?:home (?:dir\w*|folder)|filesystem|file system|system (?:drive|disk|partition)|hard (?:drive|disk)|boot (?:drive|disk|partition)))(?![\w/.~-])
    fill\w* (?:up )?(?:the |my |all )?(?:disk|drive|ssd)(?: space)? (?:until|till|on purpose|to (?:see|test|check|simulate))|simulate (?:a )?full disk|disk[- ]full (?:test|scenario|simulation)
    (?:disk|ssd)\w* (?:\w+ )?(?:sil|bicimlendir|formatla)\w*|sistemi bozabilir
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
    overnight|over night|over the weekend|while i(?:'?m)? (?:sleep\w*|away|out|at work)|all night|all day
    (?:let|leave|keep) (?:it|this|that|them|everything) (?:go|going|run|running|cook|cooking|churn\w*|chug\w*|grind\w*|crunch\w*|on)
    (?:run|running) (?:it |this |them )?(?:in the background|unattended)
    for (?:a few |several |many |\d+ )?(?:hours|days)|takes? (?:hours|forever|days|ages)
    (?:will|would|might|could|it'?ll|gonna|going to) take (?:hours|forever|days|ages|all night)
    run for (?:like |about |around )?\d+ ?(?:h|hrs?|hours|days)
    toda la noche|durante horas|tarda horas|u(?:e)?ber nacht|stundenlang|gece boyunca|saatlerce
    a noite toda|durante a noite|por horas|demora horas|for (?:an|one|a full) hour|all day|for a day
`);

export const heavyTask = family(String.raw`
    param(?:eter)? (?:sweep|search)|grid search|random search|hyper-?param\w* (?:search|sweep|tuning|optimi[sz]\w*)
    optuna|ray tune|backtest\w*|fuzz\w*|render\w*|monte carlo|benchmark\w*|batch (?:job|process\w*)
    (?:pre-?)?train\w* (?:[\w-]+ ){0,4}?from scratch|pre-?training
    (?:process|aggregat|crunch|analy[sz]|index|ingest|transform|dedup|reprocess)\w* (?:[\w.-]+ ){0,6}?(?:datasets?|parquet|csvs?|logs|corpus|tables?|records|rows|dumps?)
    transcod\w*|re-?encod\w*|(?:convert|encode|compress)\w* (?:\w+ ){0,5}?(?:to|into|as|with) (?:av1|hevc|h\.?265|x265|vp9|prores)
`);

// Data volumes that make a job long, counted only next to another sign of real work
export const volume = /(?<![\w.])(\d+(?:\.\d+)?) ?(tb|terabytes?|gb|gigabytes?)(?![a-z])/g;

// The data a volume measures, so a database size beside an unrelated task does not count
export const volumeOf =
    /^ (?:of )?(?:[\w.-]+ ){0,2}?(?:datasets?|data|parquet|csvs?|logs?|files|images|videos|corpus|dumps?|archives?|tables?|records|rows|footage|recordings|photos)(?![a-z])/;

// A count of items times the time each takes, such as 40k runs at 3s each
export const perItem =
    /(?<![\w.])(\d+(?:[.,]\d+)?)(k)?\+? (?:[a-z-]+ ){0,2}?[a-z]+s?\b[^\n]{0,24}?\b(?:at |@ |~|about |around )*~?(\d+(?:\.\d+)?) ?(s|sec|secs|seconds?|m|mins?|minutes?|h|hrs?|hours?)(?: each| apiece| per | a piece)/g;

// Builds of projects so large that one local build takes an hour or more
export const longBuild = family(String.raw`
    (?:compile|build|compil\w*|derle\w*|kompilier\w*) (?:\w+ ){0,3}?(?:chromium|llvm|clang|firefox|aosp|android (?:source|os|platform|rom|tree|system image)|webkit|kernel(?![- ]?modul))
    (?:compile|build|compil\w*|derle\w*|kompilier\w*) (?:\w+ ){0,2}?(?:kernel|gcc|qt ?\d?|tensorflow|pytorch|libreoffice|electron|node(?:js)?|python|rustc|swift) from source
`);

// A build that starts from nothing, which makes a big project take hours
export const fromScratch = /\b(?:from source|from scratch|the (?:entire|whole|full)|everything)\b/;

export const loadTest = family(String.raw`
    load[- ]?test\w*|stress[- ]?test\w*|soak test\w*|(?:\d+k?|thousands of) (?:rps|requests per second|concurrent (?:users|connections))
    yuk testi|prueba de carga|lasttest\w*|teste de carga
`);

export const heat = family(String.raw`
    (?:laptop|mac|macbook|machine|computer|pc|cpu|gpu) (?:\w+ )?(?:overheat\w*|gets hot|heats up|melt\w*|cook\w*|fry\w*|on fire|throttl\w*)
    melt\w* (?:my |the )?(?:laptop|mac|macbook|machine|computer|pc|cpu|gpu)|thermal throttl\w*
    fans? (?:spin|scream|go crazy|get loud)|drains? (?:my )?battery
    isiniyor|se calienta|wird hei(?:ss)?|lufter|esquenta
`);

// A job's own stated length, as in takes about 6 hours, rather than a time of day
export const statedLength =
    /(?:takes?|taking|take|lasts?|runs? for) (?:about |around |roughly |like |~|over |more than |at least |up to )?$/;

export const hours =
    /(?<![\w.])(\d+(?:\.\d+)?) ?(?:h|hr|hrs|hours?|horas?|stunden?|std|saat\w*)(?![a-z])/g;
export const minutes =
    /(?<![\w.])(\d+) ?(?:min|mins|minutes?|minutos?|minuten?|dakika\w*)(?![a-z])/g;
export const repeats =
    /(?<![\w.])(\d+) (?:times|veces|vezes|mal|kez|defa|runs|iterations|builds)(?![a-z])/g;
export const batch =
    /(?<![\w.])(\d+(?:[.,]\d+)?)(k)?\+? ?(?:[a-z-]+ ){0,2}?(?:images?|pictures?|photos?|files?|videos?|clips?|recordings?|episodes?|tracks?|songs?|documents?|pdfs?|combos?|combinations?|samples?|shots?|avatars?|lectures?|podcasts?|runs?|configs?|configurations?|hours of (?:audio|video|footage))(?![a-z])/g;
export const wholeBatch = family(String.raw`
    (?:all|every|whole) (?:of )?(?:my|the|our) (?:\w+ )?(?:backlog|archive|library|recordings|footage|dataset|photos|videos|collection)
    (?:my|the|our) (?:whole|entire|full) (?:[\w.-]+ ){0,2}?(?:backlog|archive|library|recordings|footage|dataset|photos|videos|collection|catalog|dump|corpus)
`);
export const epochs = /(?<![\w.])(\d+) epochs?(?![a-z])/g;

/* Signals against an offer */

export const concept = family(String.raw`
    ^(?:what|whats|what's|which|why|explain|eli5|how come|how much|how many|is it (?:possible|worth|true)|should i|would it|do i need)
    ^(?:acikla|explica|explique|explicar|erkla(?:e)?r)\w*
    how (?:does|do|did|is|are|would) (?:\S+ ){0,6}?(?:work|works|differ|compare|detect\w*|handle\w*)
    (?:what'?s|what is) the difference|difference between|pros and cons|just curious|out of curiosity|theoretically|in theory
    nedir|nasil calisir|ne ise yarar|farki ne\w*|ne kadar [^\n]{0,30}?(?:ister|gerekir|tutar)|merak ediyorum
    que es|como funciona|cual es la diferencia|por que
    was ist|wie funktioniert|was ist der unterschied|nur theoretisch|theoretisch
    o que (?:e|faz)|qual a diferenca
`);

// Asking for an explanation, which cancels subjects in its own clause only
export const explainOnly = family(String.raw`
    explain|walk me through|acikla\w*|explica\w*|erkla(?:e)?r\w*|explicar|explique
`);

export const readOnly = family(String.raw`
    (?:just|only) (?:read|look at|browse|grep|review|audit|explain|inspect)
    (?:don'?t|dont|do not|without|no need to|not going to|won'?t|never) (?:\w+ ){0,2}?(?:run|execute|install|build)\w*(?: or (?:run|install|execute|build)\w*)? (?:anything|it|them|this|that)(?! (?:on|in|onto|near|locally|here|myself)(?![a-z]))
    read[- ]only
    sadece (?:oku|incele|bak)\w*|calistirma(?:dan|yin)|kurmadan
    solo (?:leer|revisar|mirar|explicar)|sin (?:ejecutar|instalar|correr)
    nur (?:lesen|anschauen|durchsehen|pru(?:e)?fen)|ohne (?:auszufu(?:e)?hren|zu installieren)
    nicht ausfu(?:e)?hren|nichts (?:installieren|ausfu(?:e)?hren)
    so (?:explicar|ler|olhar)|nao (?:precisa |quero que (?:voce )?)(?:mud|alter|rod|execut|instal)\w*|sem (?:rodar|executar|instalar)
    no (?:cambies|modifiques|ejecutes|instales|corras) nada|nichts (?:a(?:e)?ndern|vera(?:e)?ndern)
`);

export const hosted = family(String.raw`
    openai(?![ /-]whisper)|anthropic|claude api|gemini api|google (?:cloud )?(?:tts|speech|text-to-speech|vertex)
    vertex ai|azure (?:openai|speech|tts|cognitive)|aws polly|amazon polly|bedrock
    elevenlabs|eleven labs|replicate|deepgram|assembly ?ai|stability(?: ai)? api
    apis? (?:da|de|der|del|do|von) (?:\w+ )?(?:stability|openai|elevenlabs|replicate|google|anthropic|mistral|deepgram|cohere|groq)
    together\.ai|together ai|fireworks\.ai|fireworks ai|groq|fal\.ai|runway ?ml|runway api|luma api|cartesia
    play\.?ht|hugging ?face inference|inference (?:api|endpoints?)|openrouter|cohere
    (?:mistral|deepseek|qwen|gemma|llama|perplexity|midjourney) (?:api|platform)|speechmatics|rev\.ai|hume ai
    api key|api_key|whisper api|(?:tts|speech|transcription|image generation|video generation) api
`);

// Unvetted code that wants the user's keys, the classic way such tools steal them
export const wantsSecrets = family(String.raw`
    (?:needs?|requires?|asks? (?:me )?for|wants?|uses|takes|reads|grabs|expects) (?:\w+ ){0,3}?(?:api[- _]?keys?|private keys?|seed phrases?|mnemonic|wallet (?:keys?|files?)|secret keys?|passwords?|tokens?|credentials|cookies|keystore)
    (?:enter|paste|put|give it|type) (?:in )?(?:\w+ ){0,2}?(?:private keys?|seed phrases?|mnemonic|api[- _]?keys?|passwords?|wallet (?:keys?|files?))
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
    (?:my|our) (?:own )?(?:app|apps|application|project|repo|repository|code|codebase|service|api(?! (?:keys?|tokens?|secrets?|credentials))|server|site|website|portfolio|script|component|module|tests|test suite|library|lib|package|cli|bot|extension|plugin|mod|dotfiles|backend|frontend|dashboard|blog|startup|saas|game|fork|branch|pr|workflow|pipeline|infra|cluster|monorepo|chatbot|agent)(?! (?:posts?|articles?|entries|photos?|videos?|recordings?|episodes?|notes|content|assets))
    (?:src|lib|app|routes|components|pages|tests?|spec|internal|cmd|pkg)/[^ \n]+\.(?:tsx?|jsx?|py|go|rs|rb|java|kt|swift|cs|php|vue|svelte)
    [\w-]+\.(?:tsx|jsx|vue|svelte)
    (?:benim|kendi) (?:projem|uygulamam|kodum|sitem|repom|botum)\w*|projemdeki|projemde|uygulamamda|kodumda|repomda
    (?:mi|nuestro|nuestra) (?:propio )?(?:proyecto|app|aplicacion|codigo|repo|sitio|pagina|bot|modulo|mod)
    (?:meu|minha|nosso|nossa) (?:proprio )?(?:projeto|app|aplicativo|aplicacao|codigo|repo|site|componente|bot|mod|modulo)
    (?:mein|meine|meinem|meinen|unser|unsere|unserem) (?:eigene\w* )?(?:projekt|code|app|repo|anwendung|seite|bot|modul)
`);

export const docs = family(String.raw`
    (?:write|draft|update|generate|create|add|improve|rewrite|reword|rephrase|proofread|polish|translate|summari[sz]e|outline)(?: up)? (?:[\w'-]+ ){0,4}?(?:readme|docs?|documentation|changelog|blog post|article|tutorial|markdown|guide|docstrings|plan|spec|proposal|outline|rfc|runbook|checklist|write-?up|post|essay|report)
    (?:readme|docs?|documentation|changelog|markdown)(?: [\w'-]+){0,2} (?:section|paragraph|page|wording|text|copy)
    (?:readme|docs?|dokumantasyon|dokumentation|documentacion|documentacao)\w* (?:yaz|schreib|escrib|escrev)\w*
`);

export const tests = family(String.raw`
    (?:write|add|generate|create) (?:\w+ ){0,2}?(?:unit |integration |e2e )?tests?
    (?:write|add|generate|create|draft) (?:me )?(?:an? |the |some )?(?:[\w-]+ ){0,2}?(?:load|stress|soak|perf|performance|benchmark|k6|locust|jmeter|artillery|gatling|e2e|playwright|cypress)(?: test)? ?(?:scripts?|tests?|suites?|scenarios?|plans?)
    unit-?tests? (?:\w+ ){0,3}?schreib\w*|tests? unitarios|testes? unitarios|test(?:leri)? yaz\w*
`);

export const edit = family(String.raw`
    fix|refactor|rename|convert|clean up|tidy|lint|bump|upgrade|squash|commit|push|deploy|migrate|merge|rebase|rewrite
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

const privateNet = String.raw`(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.[\d./]{1,15}`;

export const lanScan = new RegExp(
    String.raw`(?<![a-z])(?:scan|nmap|port ?scan|sweep|enumerate|map|discover|tara|escane|scann)\w{0,12}[^\n]{0,60}?(?:${privateNet}|(?:my|our|the) (?:home |local |lab |office )?(?:network|lan|subnet|wifi)|home ?lab)|(?<![\w.])${privateNet}[^\n]{0,40}?(?:open ports|services?|scan)`,
    "g",
);

export const privateTarget = new RegExp(
    String.raw`^(?:${privateNet}|localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?)(?::\d+)?(?:/|$)`,
);
