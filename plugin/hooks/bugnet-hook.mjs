// packages/intent/src/hook.ts
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

// packages/intent/src/lexicon.ts
function family(src) {
  const body = src.split("\n").map((l) => l.trim()).filter((l) => l !== "").join("|").replace(/([a-z]) \?(?=[a-z(])/g, "$1[- ]?");
  return new RegExp(`(?<![a-z0-9_])(?:${body})(?![a-z0-9_])`, "g");
}
function find(re, s) {
  re.lastIndex = 0;
  return re.exec(s);
}
function findAll(re, s) {
  const out = [];
  re.lastIndex = 0;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    out.push(m);
    if (m[0] === "") re.lastIndex++;
  }
  return out;
}
var action = family(String.raw`
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
var runsPasted = family(String.raw`
    (?:run|execute|exec|try|install|launch|start|paste|ejecut\w*|corre|correr|calistir\w*|ausfu(?:e)?hr\w*|rodar|roda|executar|instala\w*)(?: (?:it|this|that|these|them|those|the))?(?: (?:above|below|following|same))?(?: (?:install )?(?:commands?|scripts?|snippet|lines?|one[- ]liners?|installer|steps?|code|block))?(?= *(?:$|[\n,.!?:;]|(?:for|please|pls|on|in|here|now|again|first|and|then|so|to|from|locally|myself|anyway)(?![a-z])))
    (?:set|fire|boot) (?:it|this|that|them) up|get (?:it|this|that|them) (?:running|working|going)
    safe to (?:run|install|execute)|is (?:this|it|that) safe
`);
var taskVerb = family(String.raw`
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
var local = family(String.raw`
    locally|local|offline|self[- ]?host\w*|my own (?:gpu|hardware|machine)
    on (?:my|this|the) (?:own )?(?:machine|laptop|computer|mac|macbook(?: air| pro)?|pc|desktop|box|rig|workstation|gpu|hardware|disk|ssd)
    on my (?:m[1-5]\w*|rtx ?\d+|\d{4}|\d+ ?gb\w*)|on this (?:mac|laptop|machine|box)
    yerel\w*|lokal\w*|bilgisayar\w*|makine(?:m|mde|me|mi)\w*
    en local|localmente|en mi (?:pc|mac|maquina|ordenador|computadora|portatil|laptop|equipo)
    no meu (?:pc|mac|computador|notebook)|na minha maquina
    auf meine\w* (?:rechner|computer|laptop|pc|mac|maschine)|bei mir lokal
    sur (?:mon|ma) (?:pc|mac|ordinateur|portable|laptop|machine)|in locale|sul mio (?:pc|mac|computer|portatile)
`);
var aiName = family(String.raw`
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
var aiWeakName = family(String.raw`
    bark|piper|flux|forge|orpheus|sesame|krea|whisper|llama|gemma|mistral|wan ?2
`);
var aiContext = family(String.raw`
    tts|text[- ]to[- ]speech|voices?|speech|images?|video|models?|weights|checkpoints?|lora
    diffusion|ai|llm|gpu|vram|audio|mp3s?|wavs?|m4a|recordings?|podcasts?|transcri\w*|transkri\w*
    subtitles?|lectures?|interviews?|ollama|gguf|quantiz\w*|locally|local|offline|lokal\w*|yerel\w*
    localmente|en local|\d+(?:\.\d)? ?b|kayit\w*|kayd\w*|grabacion\w*|aufnahme\w*|gravac\w*
`);
var integrationAfter = /^(?:[- ][\w.-]+)?[- ](?:api|provider|adapter|client|sdk|integration|wrapper|endpoint|connector|plugin|keys?)s?(?![a-z])/;
var aiTask = family(String.raw`
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
var voiceClone = family(String.raw`
    clon\w* (?:my |a |his |her |their |this |the |someone'?s |our )?(?:own )?(?:\w+ )?voices?|cloned voices?|voice ?clon\w*
    (?:my|his|her|their|a) voice (?:as|for) (?:a |an )?(?:tts|voice ?over|narrat\w*)
    clon(?:ar|a|e) (?:mi |la |su |minha |sua )?voz|klon\w* (?:meine |die |seine )?stimme|ses(?:imi|ini|i)? klon\w*
    (?:meine|die|seine|ihre) stimme (?:zu )?klon\w*|(?:mi|tu|su|minha|sua) voz clonad[ao]
    clon\w* (?:(?:la|ma|sa|mia|sua|ta|tua) ){0,2}(?:voce|voix)
`);
var localAssistant = family(String.raw`
    (?:private|offline|local|self[- ]?hosted|personal) (?:ai |chat ?|llm |gpt )?(?:assistant|chatbot|chat ?gpt|gpt|llm|copilot)
    (?:chatgpt|gpt|claude|copilot|perplexity|gemini)[- ]?(?:like|style|alternative|clone|replacement)
    (?:assistant|chatbot|chat ?gpt|llm) (?:\w+ ){0,3}?(?:on|in) my (?:own )?(?:computer|machine|laptop|mac|pc|hardware|server)
`);
var videoName = family(String.raw`
    wan ?2\.\d|hunyuan ?video|ltx[- ]?(?:video|2)|cogvideo\w*|mochi[- ]?1|animatediff
    stable video diffusion|framepack|text[- ]to[- ]video|image[- ]to[- ]video|video model
`);
var paramSize = /(?<![a-z0-9_.])(\d{1,3}(?:\.\d)?) ?b(?![a-z0-9_])/g;
var weightsCue = family(String.raw`
    \d+ ?(?:gb|gigs?|gigabytes?) (?:of )?(?:weights|models?|checkpoints?|downloads?)|weights|checkpoints?|safetensors
`);
var repoUrl = /(?:https?:\/\/)?(?:www\.)?(?:github\.com|gitlab\.com|codeberg\.org|bitbucket\.org|gitee\.com|sourceforge\.net)\/[\w.-]+\/[\w.-]*[\w-]|git@(?:github\.com|gitlab\.com|bitbucket\.org):[\w.-]+\/[\w.-]*[\w-]/g;
var hfUrl = /(?:https?:\/\/)?huggingface\.co\/(?:spaces\/|datasets\/)?[\w.-]+\/[\w.-]*[\w-]/g;
var anyUrl = /https?:\/\/[^\s'"<>)\]]{0,400}[^\s'"<>)\].,;:!?]/g;
var scriptUrl = /https?:\/\/[^\s'"<>)\]]{1,400}\.(?:sh|bash|ps1|py|js|bat|cmd|vbs)(?![\w])/g;
var ownRepoBefore = family(String.raw`
    (?:my|our|mine|benim|kendi|mi|nuestro|meu|nosso|mein\w*|unser\w*) (?:own |propio |eigene\w* )?(?:\w+ )?(?:repo|repository|fork|project|app|site|code|repom|projem|proyecto|projeto|projekt)\w*[ :]*(?:at |on |from |is |here |-)?$
`);
var codeNoun = String.raw`(?:repo|repos|repository|script|scripts|(?<!(?:csv|json|pdf|data|log|text|config|excel|word|design|figma|image|video|audio) )files?|binary|binaries|tool|tools|bot|bots|exe|executable|zip|archive|app|apk|dmg|msi|installer|program|plugin|extension|package|mod|mods|patcher|crack|cheat|hack|cli|one[- ]liner|take[- ]home|mcp server|\w[\w-]{0,40}\.(?:exe|zip|rar|7z|apk|dmg|pkg|app|msi|jar|sh|py|js|ps1|bat))(?![a-z0-9_])`;
var person = String.raw`(?:an? |my |some |this |that |the |random )?(?:random )?(?:friend|buddy|mate|cousin|brother|sister|someone|somebody|some ?one|guy|dude|stranger|recruiter|client|vendor|person|user(?!s)|redditor|youtuber|streamer|seller|account|anon|interviewer|hiring manager|headhunter|employer)s?(?! (?:on|from|in|at) (?:my|our) (?:team|company|org|work|office|department))`;
var handed = String.raw`(?:sent|sends|send|shared|shares|gave|gives|linked|links|dropped|drops|posted|posts|dm'?d|dmed|messaged|emailed|uploaded|recommended|recommends|passed|forwarded|handed)`;
var place = String.raw`(?:reddit|subreddit|discord|telegram|youtube|tiktok|twitter|tweet|x\.com|forum|forums|hacker news|4chan|facebook|instagram|whatsapp|pastebin|gist|medium|blog|random (?:site|website|page)|website|video|livestream|stream|group chat|channel|thread|comments?|dms?|github|gitlab)`;
var pronoun = String.raw`(?:this|it|these|them|that)(?= *(?:$|[\n,.!?:;]|(?:on|over|via|in|from|earlier|yesterday|today|last|and|but|to|so|which|for)(?![a-z])))`;
var handedObject = String.raw`(?: (?:me|us|him|her|them))?(?: (?:${pronoun}|(?:(?:a|an|the|this|that|these|those|their|his|her|some|over|along) )?(?:link to (?:(?:a|an|the|this|their|his|her|some) )?)?(?:[\w'.-]{1,40} ){0,3}?${codeNoun}))`;
var origin = family(String.raw`
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
var paidApp = String.raw`(?:photoshop|office|windows|adobe|fl studio|capcut|autocad|premiere|illustrator|lightroom|after effects|matlab|ableton|vegas|corel|spotify|netflix|youtube)`;
var aiApp = String.raw`(?:claude code|claude|copilot|cursor|chatgpt|sora|kling|seedance|midjourney|elevenlabs|voicemod)`;
var game = String.raw`(?:roblox|valorant|fortnite|cs2|csgo|counter[- ]strike|apex legends|warzone|gta|pubg|tarkov|overwatch|r6|dota|genshin|free fire|minecraft|rust|apex|cod)`;
var lure = family(String.raw`
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
var ownBefore = /(?:^|[\s(])(?:my|our|mine|mi|mis|meu|minha|nosso|benim|kendi|mein\w*|unser\w*|nuestro)\s(?:\S+\s){0,2}$/;
var createBefore = /(?:build|write|create|make|code|develop|implement|scaffold|program)\s(?:me\s)?(?:a|an|my|our|the)\s(?:\S+\s){0,2}$/;
var poc = family(String.raw`
    exploits?|exploit code|cve-\d{4}-\d{3,7}|0[- ]?day|zero[- ]?day|rce|privesc
    lpe|reverse shell|bind shell|shellcode|msfvenom|metasploit|exploit'?\w*
`);
var pocWeak = family(String.raw`
    pocs?|proof[- ]of[- ]concept
`);
var flaw = family(String.raw`
    cve\w*|vuln\w*|security (?:bug|flaw|hole|issue|advisory)|bug bounty|rce|privesc|lpe
    (?:buffer|heap|stack|integer) overflow|\w+ injection|use[- ]after[- ]free|zero[- ]?day|0[- ]?day
    payloads?|shellcode|(?:the|this|that|a|an|new) (?:[\w.-]+ ){0,2}?(?:bug|flaw)
    zafiyet\w*|guvenlik acig\w*|vulnerabilidad\w*|vulnerabilidade\w*|schwachstelle\w*|sicherheitslu(?:e)?cke\w*
`);
var exploitUse = family(String.raw`
    (?:run|runs|running|execute|exec|launch|try|test|compile|build|clone|download|fire|use|pull|grab|fetch)\w* (?:[\w.'-]+ ){0,4}?exploits?
    exploits? (?:code|script|scripts|binary|repo|chain|kit|against|on (?:my|our|the|a)|for (?:cve|the|this|that))
    (?:ejecut|corr|prueb|lanz|compil|clon|descarg|ausfu(?:e)?hr|start|rod|execut|calistir|dene|derle|indir)\w* (?:[\w.'-]+ ){0,4}?exploit\w*
`);
var receivedFile = /\.(?:zip|rar|7z|exe|msi|scr|bat|cmd|ps1|vbs|jar|lnk|iso|dmg|pkg|app|apk|docm|xlsm|pptm|hta|pif)(?![a-z0-9_])/g;
var receivedContext = family(String.raw`
    attachment|attached|e-?mail(?:ed)?|got an? (?:email|message|dm)|sent me|dm'?d me
    over (?:telegram|whatsapp|discord|email|signal|slack)|on whatsapp|never heard of
    unknown (?:sender|vendor|client)|ekte(?:ki)?|mail\w* gelen|adjunto|me enviaron|anhang|angehangt|anexo
    macros?|makro\w*
`);
var mailed = family(String.raw`
    (?:e-?mail|mail|message|inbox)(?:ed)? (?:\w+ ){0,2}?attachments?|attachments? (?:from|in|of) (?:an? |the |some )?(?:\w+ ){0,2}?(?:e-?mails?|mail|messages?|sender|stranger)
    (?:as|in) an? (?:e-?mail )?attachment|(?:came|arrived|sent|got) (?:\w+ ){0,2}?(?:by|via|over|in an?) e-?mail
    e-?mail(?:ed)? (?:me|us) (?:an? |the |this |some )?(?:\w+ ){0,2}?(?:scripts?|programs?|exe|binar(?:y|ies)|installers?|executables?|apps?)
    adjunto (?:de|en|del) (?:un |el )?correo|anhang (?:einer|der|aus der) (?:e-?mail|mail)|anexo (?:de|do|no) (?:um |o )?e-?mail
    e-?posta eki\w*|mailde(?:ki)? ek\w*
`);
var codeKind = family(String.raw`
    scripts?|programs?|exe|executables?|binar(?:y|ies)|installers?|javascript|js|python|powershell
    macros?|apk|payloads?|skript|programm|programa|ejecutable|executavel
`);
var disguisedFile = /\.(?:pdf|docx?|xlsx?|jpe?g|png|mp4|mp3|txt)\.(?:exe|scr|bat|cmd|js|vbs|lnk|com|pif)(?![a-z0-9_])/g;
var enableMacros = family(String.raw`
    enable (?:the )?(?:macros|content|editing)|habilitar (?:macros|contenido)|makros aktivieren|inhalt aktivieren
`);
var avOff = family(String.raw`
    xattr|com\.apple\.quarantine|quarantine (?:flag|attribute)|damaged and can'?t be opened|cant be opened
    can'?t be opened because|unidentified developer|spctl --master-disable
    (?:disable|turn off|switch off) (?:the )?(?:gatekeeper|sip|windows defender|defender|antivirus|av|smartscreen|real[- ]time protection)
    (?:defender|antivirus)\w* (?:kapat|devre disi)\w*|desactiva\w* (?:el )?(?:defender|antivirus)
    (?:defender|virenschutz|antivirus) (?:deaktivieren|ausschalten)|desativ\w* (?:o )?(?:defender|antivirus)
`);
var safety = family(String.raw`
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
var repoWord = family(String.raw`
    repo|repos|repository|repositorio|depo(?:su|yu|yi)?|repoyu|repoyi|reposu|binary|binaries|script|scripts
    tool|program|app|installer|plugin|extension|mod|bot|exe|zip|archive|command|take[- ]home|assignment
    projeto|programa|herramienta|skript|programm|arac|uygulama
`);
var explicit = family(String.raw`
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
var notIsolation = family(String.raw`
    iframe|stripe|paypal|braintree|plaid|adyen|square|razorpay|mollie|klarna|checkout|payments?|merchant
    odeme\w*|iyzico|paytr|sanal pos|pagos?|pasarela|pagamentos?|zahlung\w*
    testcontainers|test ?containers?|per test|each test|for each test|test fixtures?|in ci
    test (?:cards?|card numbers?|mode|merchants?|accounts?|users?)|card numbers?|credit cards?
    in-app purchases?|iap|storekit|app store|testflight|google play|play console|ios build|android build
    salesforce|apex|sfdx|scratch orgs?|crm|hubspot|zoho|netsuite|shopify|ebay|amazon pay|twilio|docusign|coinbase
    sandbox (?:attribute|attr|flag|mode|accounts?|keys?|credentials|api|url|domain|orgs?|tenant|instance|users?|testers?|store)
`);
var notMine = family(String.raw`
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
var nvidiaOnly = family(String.raw`
    cuda(?:[- ]?\d+(?:\.\d+)?)?|nvidia(?: gpu| card| drivers?)?|cupy|numba\.cuda|flash[-_ ]?attn\w*|flash[- ]attention
    xformers|bitsandbytes|triton|tensorrt|cudnn|cuda[- ]toolkit|nvidia[- ]container[- ]toolkit|nvcc
    vllm|exllamav2|auto[- ]gptq|mamba[- ]ssm
`);
var nvidiaNeed = family(String.raw`
    (?:needs?|requires?|requiring|depends on|built for|only (?:runs|works) (?:on|with)|won'?t run without|must have)\b[^\n]{0,30}?\b(?:cuda|nvidia)
    (?:precisa|requer|necesita|requiere|braucht|benotigt|gerektir\w*)\b[^\n]{0,30}?\b(?:cuda|nvidia)
    (?:so|solo|nur|sadece|apenas) (?:funciona|roda|corre|funktioniert|lauft|calisir)\w*\b[^\n]{0,30}?\b(?:cuda|nvidia)
    (?:cuda|nvidia)[- ]only|cupy|numba\.cuda|flash[-_ ]?attn\w*|flash[- ]attention|xformers|bitsandbytes|triton|tensorrt
    vllm|exllamav2|auto[- ]gptq|mamba[- ]ssm|nvidia[- ]container[- ]toolkit
`);
var rawDevice = family(String.raw`
    /dev/(?:sd[a-z]|nvme\d|disk\d|hd[a-z]|mmcblk\d)
`);
var remoteTarget = family(String.raw`
    (?:on|in|to|onto|into) (?:the|our|my|a|an|this|that) (?:\w+ )?(?:server|servers|vps|ec2|droplet|cluster|k8s|kubernetes|pod|runpod|colab|kaggle|lambda|homelab|nas|raspberry pi|ci|ci runner|hosts?|instances?|bastion|fleet)
    (?:google )?colab|kaggle notebook|github actions|gitlab ci|dockerfile|devcontainer|codespace\w*|wsl2?
`);
var hardwareGap = family(String.raw`
    (?:no|don'?t have (?:an?|a dedicated)?|dont have (?:an?)?|without (?:an?)?|lack (?:an?)?) (?:nvidia |dedicated |discrete )?(?:gpu|graphics card|cuda|nvidia)
    (?:has|have) no (?:nvidia |dedicated )?(?:gpu|graphics card)
    my (?:gpu|laptop|mac|machine|pc|computer) (?:is|has|only has) (?:too )?(?:weak|slow|old|only \d+ ?gb|\d+ ?gb)
    (?:only|just) (?:\d+ ?gb (?:of )?(?:ram|vram|memory)|integrated graphics)|not enough (?:ram|vram|memory|disk|space)
    ekran kartim (?:yok|zayif)|gpu\w* yok|ram\w* yetmiyor|bilgisayarim (?:yavas|zayif|eski)
    no tengo (?:gpu|tarjeta grafica)|mi (?:pc|portatil|laptop) es (?:lento|viejo)|poca ram
    keine (?:nvidia[- ])?(?:gpu|grafikkarte)|grafikkarte (?:zu schwach|reicht nicht)|zu wenig (?:ram|speicher)
    nao tenho (?:gpu|placa de video)
`);
var linuxOnly = family(String.raw`
    (?:only|solo|nur|sadece|apenas|just) (?:\w+ ){0,3}?(?:on |en |auf |em )?linux|linux[- ]only|linux x86[_-]?64
    only (?:ships|supports|has|runs on|works on) (?:\w+ ){0,2}?linux|requires? linux|needs? linux
    so (?:funciona|roda|rodam|funcionam|existe|compila)\w* (?:\w+ ){0,2}?(?:em |no )?linux
    ebpf|bpftrace|bcc tools|io_uring|systemd|systemctl|apt(?:-get)?|kvm|lxc|cgroups?|ip netns|nftables|iptables
    linux'?(?:ta|te|da|de)|linux binar\w*
`);
var linuxConfigAfter = /^[ -](?:(?:service|unit|timer|socket|sources?) )?(?:files?|units?|rules?|config\w*|configuration|polic(?:y|ies)|profiles?|chains?|manifests?|templates?|definitions?)(?![a-z])/;
var x86Only = family(String.raw`
    x86(?:[_-]64)?|amd64|intel mkl|mkl|avx[- ]?512|avx2?|rosetta|intel[- ]only|only (?:\w+ ){0,2}?intel
`);
var macText = family(String.raw`
    mac|macs|macbook\w*|macos|mac os|apple silicon|m[1-5](?: pro| max| ultra| air)? (?:mac|macbook|chip)\w*
    (?:i'?m|im|i am) on (?:an? )?m[1-5]|mac kullaniyorum|uso (?:una )?mac
`);
var windowsText = family(String.raw`
    (?:i'?m|im|i am) on windows|windows (?:10|11)|on my (?:windows|win) (?:pc|laptop|machine)
`);
var driverText = family(String.raw`
    (?:instal\w*|updat\w*|upgrad\w*|set ?up|kur\w*) (?:the )?(?:nvidia|cuda|gpu|graphics) (?:drivers?|toolkit)
    (?:(?:nvidia|cuda|gpu|graphics)[- ](?:card )?)+(?:drivers?|toolkit)|drivers? for (?:my |the |an? )?(?:nvidia|gpu|graphics)
    kernel modul\w*|dkms|out[- ]of[- ]tree (?:driver|module)|custom kernel|kernel patch\w*
`);
var destructive = family(String.raw`
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
var kernelText = family(String.raw`
    mitigations=off|kernel (?:param\w*|parameters?|args?|cmdline|tuning|modules?)|sysctl|grub|grubby
    cpufreq|hugepages|swappiness|selinux|apparmor|secure boot
`);
var heavyPhrase = family(String.raw`
    overnight|over night|over the weekend|while i(?:'?m)? (?:sleep\w*|away|out|at work)|all night|all day
    (?:let|leave|keep) (?:it|this|that|them|everything) (?:go|going|run|running|cook|cooking|churn\w*|chug\w*|grind\w*|crunch\w*|on)
    (?:run|running) (?:it |this |them )?(?:in the background|unattended)
    for (?:a few |several |many |\d+ )?(?:hours|days)|takes? (?:hours|forever|days|ages)
    (?:will|would|might|could|it'?ll|gonna|going to) take (?:hours|forever|days|ages|all night)
    run for (?:like |about |around )?\d+ ?(?:h|hrs?|hours|days)
    toda la noche|durante horas|tarda horas|u(?:e)?ber nacht|stundenlang|gece boyunca|saatlerce
    a noite toda|durante a noite|por horas|demora horas|for (?:an|one|a full) hour|all day|for a day
`);
var heavyTask = family(String.raw`
    param(?:eter)? (?:sweep|search)|grid search|random search|hyper-?param\w* (?:search|sweep|tuning|optimi[sz]\w*)
    optuna|ray tune|backtest\w*|fuzz\w*|render\w*|monte carlo|benchmark\w*|batch (?:job|process\w*)
    (?:pre-?)?train\w* (?:[\w-]+ ){0,4}?from scratch|pre-?training
    (?:process|aggregat|crunch|analy[sz]|index|ingest|transform|dedup|reprocess)\w* (?:[\w.-]+ ){0,6}?(?:datasets?|parquet|csvs?|logs|corpus|tables?|records|rows|dumps?)
    transcod\w*|re-?encod\w*|(?:convert|encode|compress)\w* (?:\w+ ){0,5}?(?:to|into|as|with) (?:av1|hevc|h\.?265|x265|vp9|prores)
`);
var volume = /(?<![\w.])(\d+(?:\.\d+)?) ?(tb|terabytes?|gb|gigabytes?)(?![a-z])/g;
var volumeOf = /^ (?:of )?(?:[\w.-]+ ){0,2}?(?:datasets?|data|parquet|csvs?|logs?|files|images|videos|corpus|dumps?|archives?|tables?|records|rows|footage|recordings|photos)(?![a-z])/;
var perItem = /(?<![\w.])(\d+(?:[.,]\d+)?)(k)?\+? (?:[a-z-]+ ){0,2}?[a-z]+s?\b[^\n]{0,24}?\b(?:at |@ |~|about |around )*~?(\d+(?:\.\d+)?) ?(s|sec|secs|seconds?|m|mins?|minutes?|h|hrs?|hours?)(?: each| apiece| per | a piece)/g;
var longBuild = family(String.raw`
    (?:compile|build|compil\w*|derle\w*|kompilier\w*) (?:\w+ ){0,3}?(?:chromium|llvm|clang|firefox|aosp|android (?:source|os|platform|rom|tree|system image)|webkit|kernel(?![- ]?modul))
    (?:compile|build|compil\w*|derle\w*|kompilier\w*) (?:\w+ ){0,2}?(?:kernel|gcc|qt ?\d?|tensorflow|pytorch|libreoffice|electron|node(?:js)?|python|rustc|swift) from source
`);
var fromScratch = /\b(?:from source|from scratch|the (?:entire|whole|full)|everything)\b/;
var loadTest = family(String.raw`
    load[- ]?test\w*|stress[- ]?test\w*|soak test\w*|(?:\d+k?|thousands of) (?:rps|requests per second|concurrent (?:users|connections))
    yuk testi|prueba de carga|lasttest\w*|teste de carga
`);
var heat = family(String.raw`
    (?:laptop|mac|macbook|machine|computer|pc|cpu|gpu) (?:\w+ )?(?:overheat\w*|gets hot|heats up|melt\w*|cook\w*|fry\w*|on fire|throttl\w*)
    melt\w* (?:my |the )?(?:laptop|mac|macbook|machine|computer|pc|cpu|gpu)|thermal throttl\w*
    fans? (?:spin|scream|go crazy|get loud)|drains? (?:my )?battery
    isiniyor|se calienta|wird hei(?:ss)?|lufter|esquenta
`);
var statedLength = /(?:takes?|taking|take|lasts?|runs? for) (?:about |around |roughly |like |~|over |more than |at least |up to )?$/;
var hours = /(?<![\w.])(\d+(?:\.\d+)?) ?(?:h|hr|hrs|hours?|horas?|stunden?|std|saat\w*)(?![a-z])/g;
var minutes = /(?<![\w.])(\d+) ?(?:min|mins|minutes?|minutos?|minuten?|dakika\w*)(?![a-z])/g;
var repeats = /(?<![\w.])(\d+) (?:times|veces|vezes|mal|kez|defa|runs|iterations|builds)(?![a-z])/g;
var batch = /(?<![\w.])(\d+(?:[.,]\d+)?)(k)?\+? ?(?:[a-z-]+ ){0,2}?(?:images?|pictures?|photos?|files?|videos?|clips?|recordings?|episodes?|tracks?|songs?|documents?|pdfs?|combos?|combinations?|samples?|shots?|avatars?|lectures?|podcasts?|runs?|configs?|configurations?|hours of (?:audio|video|footage))(?![a-z])/g;
var wholeBatch = family(String.raw`
    (?:all|every|whole) (?:of )?(?:my|the|our) (?:\w+ )?(?:backlog|archive|library|recordings|footage|dataset|photos|videos|collection)
    (?:my|the|our) (?:whole|entire|full) (?:[\w.-]+ ){0,2}?(?:backlog|archive|library|recordings|footage|dataset|photos|videos|collection|catalog|dump|corpus)
`);
var epochs = /(?<![\w.])(\d+) epochs?(?![a-z])/g;
var concept = family(String.raw`
    ^(?:what|whats|what's|which|why|explain|eli5|how come|how much|how many|is it (?:possible|worth|true)|should i|would it|do i need)
    ^(?:acikla|explica|explique|explicar|erkla(?:e)?r)\w*
    how (?:does|do|did|is|are|would) (?:\S+ ){0,6}?(?:work|works|differ|compare|detect\w*|handle\w*)
    (?:what'?s|what is) the difference|difference between|pros and cons|just curious|out of curiosity|theoretically|in theory
    nedir|nasil calisir|ne ise yarar|farki ne\w*|ne kadar [^\n]{0,30}?(?:ister|gerekir|tutar)|merak ediyorum
    que es|como funciona|cual es la diferencia|por que
    was ist|wie funktioniert|was ist der unterschied|nur theoretisch|theoretisch
    o que (?:e|faz)|qual a diferenca
`);
var explainOnly = family(String.raw`
    explain|walk me through|acikla\w*|explica\w*|erkla(?:e)?r\w*|explicar|explique
`);
var readOnly = family(String.raw`
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
var hosted = family(String.raw`
    openai(?![ /-]whisper)|anthropic|claude api|gemini api|google (?:cloud )?(?:tts|speech|text-to-speech|vertex)
    vertex ai|azure (?:openai|speech|tts|cognitive)|aws polly|amazon polly|bedrock
    elevenlabs|eleven labs|replicate|deepgram|assembly ?ai|stability(?: ai)? api
    apis? (?:da|de|der|del|do|von) (?:\w+ )?(?:stability|openai|elevenlabs|replicate|google|anthropic|mistral|deepgram|cohere|groq)
    together\.ai|together ai|fireworks\.ai|fireworks ai|groq|fal\.ai|runway ?ml|runway api|luma api|cartesia
    play\.?ht|hugging ?face inference|inference (?:api|endpoints?)|openrouter|cohere
    (?:mistral|deepseek|qwen|gemma|llama|perplexity|midjourney) (?:api|platform)|speechmatics|rev\.ai|hume ai
    api key|api_key|whisper api|(?:tts|speech|transcription|image generation|video generation) api
`);
var wantsSecrets = family(String.raw`
    (?:needs?|requires?|asks? (?:me )?for|wants?|uses|takes|reads|grabs|expects) (?:\w+ ){0,3}?(?:api[- _]?keys?|private keys?|seed phrases?|mnemonic|wallet (?:keys?|files?)|secret keys?|passwords?|tokens?|credentials|cookies|keystore)
    (?:enter|paste|put|give it|type) (?:in )?(?:\w+ ){0,2}?(?:private keys?|seed phrases?|mnemonic|api[- _]?keys?|passwords?|wallet (?:keys?|files?))
`);
var notHostedBefore = /(?:instead of|rather than|without|replace|not|no|don'?t|dont|than|pay for)\s(?:\S+\s){0,3}$/;
var offline = family(String.raw`
    offline (?:on|during|in) (?:a |the )?(?:flights?|planes?|trains?|trips?|commute|subway)
    (?:on|in) (?:a |the )?(?:plane|flight|airplane)|without (?:internet|wifi|wi-fi)|no (?:internet|wifi|connectivity)
    air[- ]?gapped|on my (?:phone|iphone|android|ipad)|on[- ]device|internetsiz|cevrimdisi|ucakta
    sin (?:internet|conexion)|en el avion|ohne internet|im flugzeug|sem internet|no aviao
`);
var own = family(String.raw`
    (?:my|our) (?:own )?(?:app|apps|application|project|repo|repository|code|codebase|service|api(?! (?:keys?|tokens?|secrets?|credentials))|server|site|website|portfolio|script|component|module|tests|test suite|library|lib|package|cli|bot|extension|plugin|mod|dotfiles|backend|frontend|dashboard|blog|startup|saas|game|fork|branch|pr|workflow|pipeline|infra|cluster|monorepo|chatbot|agent)(?! (?:posts?|articles?|entries|photos?|videos?|recordings?|episodes?|notes|content|assets))
    (?:src|lib|app|routes|components|pages|tests?|spec|internal|cmd|pkg)/[^ \n]+\.(?:tsx?|jsx?|py|go|rs|rb|java|kt|swift|cs|php|vue|svelte)
    [\w-]+\.(?:tsx|jsx|vue|svelte)
    (?:benim|kendi) (?:projem|uygulamam|kodum|sitem|repom|botum)\w*|projemdeki|projemde|uygulamamda|kodumda|repomda
    (?:mi|nuestro|nuestra) (?:propio )?(?:proyecto|app|aplicacion|codigo|repo|sitio|pagina|bot|modulo|mod)
    (?:meu|minha|nosso|nossa) (?:proprio )?(?:projeto|app|aplicativo|aplicacao|codigo|repo|site|componente|bot|mod|modulo)
    (?:mein|meine|meinem|meinen|unser|unsere|unserem) (?:eigene\w* )?(?:projekt|code|app|repo|anwendung|seite|bot|modul)
`);
var docs = family(String.raw`
    (?:write|draft|update|generate|create|add|improve|rewrite|reword|rephrase|proofread|polish|translate|summari[sz]e|outline)(?: up)? (?:[\w'-]+ ){0,4}?(?:readme|docs?|documentation|changelog|blog post|article|tutorial|markdown|guide|docstrings|plan|spec|proposal|outline|rfc|runbook|checklist|write-?up|post|essay|report)
    (?:readme|docs?|documentation|changelog|markdown)(?: [\w'-]+){0,2} (?:section|paragraph|page|wording|text|copy)
    (?:readme|docs?|dokumantasyon|dokumentation|documentacion|documentacao)\w* (?:yaz|schreib|escrib|escrev)\w*
`);
var tests = family(String.raw`
    (?:write|add|generate|create) (?:\w+ ){0,2}?(?:unit |integration |e2e )?tests?
    (?:write|add|generate|create|draft) (?:me )?(?:an? |the |some )?(?:[\w-]+ ){0,2}?(?:load|stress|soak|perf|performance|benchmark|k6|locust|jmeter|artillery|gatling|e2e|playwright|cypress)(?: test)? ?(?:scripts?|tests?|suites?|scenarios?|plans?)
    unit-?tests? (?:\w+ ){0,3}?schreib\w*|tests? unitarios|testes? unitarios|test(?:leri)? yaz\w*
`);
var edit = family(String.raw`
    fix|refactor|rename|convert|clean up|tidy|lint|bump|upgrade|squash|commit|push|deploy|migrate|merge|rebase|rewrite
    pull (?:the )?latest|latest changes|pull request|code review|review the
    corrige|arregla|refactoriza|duzelt\w*|behebe|reparier\w*|conserta
`);
var abuse = family(String.raw`
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
var privateNet = String.raw`(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.[\d./]{1,15}`;
var lanScan = new RegExp(
  String.raw`(?<![a-z])(?:scan|nmap|port ?scan|sweep|enumerate|map|discover|tara|escane|scann)\w{0,12}[^\n]{0,60}?(?:${privateNet}|(?:my|our|the) (?:home |local |lab |office )?(?:network|lan|subnet|wifi)|home ?lab)|(?<![\w.])${privateNet}[^\n]{0,40}?(?:open ports|services?|scan)`,
  "g"
);
var privateTarget = new RegExp(
  String.raw`^(?:${privateNet}|localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?)(?::\d+)?(?:/|$)`
);

// packages/intent/src/normalize.ts
var headChars = 16e3;
var tailChars = 4e3;
var letterFolds = {
  \u0131: "i",
  \u00DF: "ss",
  \u00F8: "o",
  \u00E6: "ae",
  \u0153: "oe",
  \u0142: "l",
  \u0111: "d",
  \u00FE: "th"
};
function clip(s) {
  if (s.length <= headChars + tailChars) return s;
  return `${s.slice(0, headChars)}
${s.slice(-tailChars)}`;
}
function norm(s) {
  const c = clip(s);
  if (/^[\t\n\r -~]*$/.test(c)) return collapse(c.toLowerCase());
  return collapse(
    c.toLowerCase().normalize("NFKD").replace(new RegExp("\\p{M}+", "gu"), "").replace(/[ıßøæœłđþ]/g, (ch) => letterFolds[ch] ?? ch).replace(/[\p{Cf}]/gu, "").replace(/[\p{Pi}\p{Pf}]/gu, "'").replace(new RegExp("\\p{Pd}", "gu"), "-").replace(/[^\t\n\r -~]+/g, " ")
  );
}
function collapse(s) {
  return s.replace(/[^\S\n]+/g, " ").replace(/ ?\n[\s]*/g, "\n").trim();
}
function ascii(s) {
  return s.replace(/[^\t\n\r -~]/g, "?");
}
function spaced(s) {
  return s.replace(/[_./:@=+\\-]+/g, " ");
}
function asTyped(subject, source) {
  const pattern = subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ +/g, "\\s+");
  return new RegExp(pattern, "i").exec(source)?.[0] ?? subject;
}
function quoteSafe(s, max = 60) {
  const flat = s.replace(/\\/g, "/").replace(/[\p{Cc}\p{Cf}"`<>]/gu, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3).trimEnd()}...` : flat;
}

// packages/intent/src/packages.ts
var heavy = (weight, group, nvidiaOnly2 = false) => ({
  weight,
  group,
  nvidiaOnly: nvidiaOnly2
});
var heavyTable = {
  torch: heavy(3, "torch"),
  torchvision: heavy(3, "torch"),
  torchaudio: heavy(3, "torch"),
  pytorch: heavy(3, "torch"),
  tensorflow: heavy(3, "tensorflow"),
  "tensorflow-gpu": heavy(4, "tensorflow", true),
  jax: heavy(3, "jax"),
  jaxlib: heavy(3, "jax"),
  transformers: heavy(3, "hf"),
  accelerate: heavy(3, "hf"),
  peft: heavy(3, "hf"),
  trl: heavy(3, "hf"),
  "sentence-transformers": heavy(3, "hf"),
  timm: heavy(3, "hf"),
  diffusers: heavy(5, "diffusion"),
  xformers: heavy(5, "cuda", true),
  "flash-attn": heavy(5, "cuda", true),
  "flash-attention": heavy(5, "cuda", true),
  bitsandbytes: heavy(5, "cuda", true),
  deepspeed: heavy(5, "cuda", true),
  triton: heavy(5, "cuda", true),
  tensorrt: heavy(5, "cuda", true),
  "auto-gptq": heavy(5, "cuda", true),
  autoawq: heavy(5, "cuda", true),
  exllamav2: heavy(5, "cuda", true),
  "mamba-ssm": heavy(5, "cuda", true),
  "causal-conv1d": heavy(5, "cuda", true),
  cupy: heavy(5, "cuda", true),
  pycuda: heavy(5, "cuda", true),
  "onnxruntime-gpu": heavy(4, "cuda", true),
  vllm: heavy(5, "llm", true),
  sglang: heavy(5, "llm", true),
  "llama-cpp-python": heavy(5, "llm"),
  ctransformers: heavy(5, "llm"),
  "mlx-lm": heavy(4, "llm"),
  unsloth: heavy(5, "train"),
  axolotl: heavy(5, "train"),
  tts: heavy(5, "tts"),
  "coqui-tts": heavy(5, "tts"),
  kokoro: heavy(5, "tts"),
  "kokoro-onnx": heavy(5, "tts"),
  "f5-tts": heavy(5, "tts"),
  "chatterbox-tts": heavy(5, "tts"),
  "parler-tts": heavy(5, "tts"),
  "piper-tts": heavy(4, "tts"),
  melotts: heavy(5, "tts"),
  styletts2: heavy(5, "tts"),
  "rvc-python": heavy(5, "tts"),
  "orpheus-speech": heavy(5, "tts"),
  "suno-bark": heavy(5, "tts"),
  bark: heavy(5, "tts"),
  audiocraft: heavy(5, "audio"),
  "openai-whisper": heavy(5, "asr"),
  whisperx: heavy(5, "asr"),
  "faster-whisper": heavy(4, "asr"),
  "insanely-fast-whisper": heavy(5, "asr"),
  "whisper-ctranslate2": heavy(4, "asr"),
  "nemo-toolkit": heavy(5, "asr"),
  "pyannote.audio": heavy(5, "asr"),
  comfyui: heavy(5, "image"),
  "comfy-cli": heavy(5, "image"),
  invokeai: heavy(5, "image"),
  fooocus: heavy(5, "image"),
  insightface: heavy(4, "image"),
  ultralytics: heavy(4, "vision"),
  detectron2: heavy(5, "vision")
};
function heavyPackage(name) {
  const n = name.toLowerCase().replace(/_/g, "-");
  if (heavyTable[n]) return heavyTable[n];
  if (/^nvidia-[a-z0-9-]+-cu\d+$/.test(n) || /^cupy-cuda\d+\w*$/.test(n)) {
    return heavy(5, "cuda", true);
  }
  return null;
}
var pypi = `
    requests request urllib3 certifi idna charset-normalizer chardet six packaging setuptools wheel pip
    virtualenv pipenv poetry uv numpy numba scipy scapy sympy pandas polars pyarrow matplotlib
    seaborn plotly bokeh scikit-learn sklearn scikit-image statsmodels networkx pillow opencv-python
    opencv-python-headless imageio moviepy pydub librosa soundfile torch torchvision torchaudio
    torchx tensorflow keras jax jaxlib xgboost lightgbm catboost transformers tokenizers datasets
    accelerate safetensors sentencepiece huggingface-hub diffusers peft trl timm einops gradio
    streamlit openai anthropic langchain langchain-openai langchain-community llama-index cohere
    groq replicate elevenlabs deepgram-sdk tiktoken flask django fastapi starlette uvicorn gunicorn
    unicorn werkzeug jinja2 jinja markupsafe itsdangerous click typer rich colorama termcolor colorlog
    loguru tqdm pyyaml yaml toml tomli tomlkit python-dotenv dotenv pydantic attrs attr marshmallow
    sqlalchemy alembic psycopg psycopg2 psycopg2-binary asyncpg pymysql mysqlclient redis celery
    kombu pymongo motor boto3 botocore s3fs awscli google-cloud-storage azure-storage-blob
    aiohttp httpx httpcore websockets websocket-client grpcio protobuf requests-oauthlib oauthlib
    pyjwt jwt cryptography pycryptodome paramiko fabric pexpect pytest pytest-cov pytest-asyncio
    tox nox coverage hypothesis black ruff flake8 pylint mypy isort autopep8 yapf pre-commit
    selenium playwright beautifulsoup4 beautifulsoup bs4 lxml html5lib scrapy mechanize discord discord.py
    python-telegram-bot telethon pyrogram tweepy praw web3 eth-account solana solders ccxt
    python-binance yfinance alpaca-trade-api ta pyautogui pynput keyboard mouse psutil watchdog
    schedule apscheduler arrow pendulum python-dateutil pytz tzdata babel regex chromadb faiss-cpu
    faiss-gpu pinecone-client qdrant-client weaviate-client sentence-transformers spacy nltk gensim jupyter
    notebook jupyterlab ipython ipykernel ipywidgets openpyxl xlrd xlsxwriter python-docx pypdf
    pypdf2 pdfplumber reportlab markdown mkdocs sphinx docutils pygments
`;
var npm = `
    react react-dom preact next vue nuxt svelte @sveltejs/kit angular @angular/core solid-js astro
    express koa fastify hapi @hapi/hapi nestjs @nestjs/core lodash lodash-es underscore ramda axios
    request node-fetch got ky superagent chalk colors kleur picocolors colorette commander yargs inquirer
    prompts ora debug dotenv dotenvx uuid nanoid moment dayjs date-fns luxon zod yup joi ajv
    typescript ts-node tsx esbuild vite vitest webpack rollup parcel @babel/core babel-loader
    eslint prettier jest mocha chai sinon supertest nodemon pm2 concurrently cross-env rimraf
    mkdirp glob fs-extra ws socket.io socket.io-client mongoose mongodb pg mysql mysql2 sqlite3
    better-sqlite3 prisma @prisma/client sequelize typeorm knex drizzle-orm redis ioredis
    jsonwebtoken bcrypt bcryptjs passport cors helmet morgan body-parser cookie-parser multer sharp
    jimp puppeteer playwright cheerio tailwindcss postcss autoprefixer sass less styled-components
    @emotion/react react-router react-router-dom redux @reduxjs/toolkit zustand jotai swr
    @tanstack/react-query react-hook-form @hookform/resolvers formik classnames clsx framer-motion
    three d3 chart.js discord.js telegraf openai @anthropic-ai/sdk ethers web3 viem wagmi
    @solana/web3.js electron nodemailer stripe aws-sdk firebase @supabase/supabase-js graphql
    @apollo/client apollo-server husky lint-staged nx turbo lerna serve http-server
    create-react-app create-next-app create-vite npm pnpm yarn bun deno
`;
var brands = `
    pytorch torch tensorflow cuda nvidia numpy pandas requests colorama discord telegram solana
    ethereum binance openai anthropic deepseek huggingface whisper stable diffusion selenium
`;
var words = (s) => s.trim().split(/\s+/);
var canonical = (s) => s.toLowerCase().replace(/[._]/g, "-");
var popular = new Set([...words(pypi), ...words(npm)].map(canonical));
var popularList = [...popular];
var brandSet = /* @__PURE__ */ new Set([...words(brands), ...popularList]);
var leet = { "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t" };
var keyRows = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
function adjacent(a, b) {
  const at = (c) => keyRows.findIndex((r) => r.includes(c));
  const [ra, rb] = [at(a), at(b)];
  if (ra === -1 || rb === -1 || Math.abs(ra - rb) > 1) return false;
  const [ca, cb] = [keyRows[ra].indexOf(a), keyRows[rb].indexOf(b)];
  return ra === rb ? Math.abs(ca - cb) === 1 : ca - cb >= -1 && ca - cb <= 1;
}
function leftmost(s, i) {
  let at = i;
  while (at > 0 && s[at - 1] === s[i]) at--;
  return at;
}
function slip(name, real) {
  if (name.length === real.length) {
    let i2 = 0;
    while (i2 < name.length && name[i2] === real[i2]) i2++;
    if (i2 >= name.length - 1) return false;
    if (name.slice(i2 + 1) === real.slice(i2 + 1)) {
      return i2 > 0 && adjacent(name[i2], real[i2]);
    }
    return name[i2] === real[i2 + 1] && name[i2 + 1] === real[i2] && name.slice(i2 + 2) === real.slice(i2 + 2);
  }
  const [long, short] = name.length > real.length ? [name, real] : [real, name];
  if (long.length !== short.length + 1) return false;
  let i = 0;
  while (i < short.length && long[i] === short[i]) i++;
  if (long.slice(i + 1) !== short.slice(i)) return false;
  const at = leftmost(long, i);
  return at > 0 && at < long.length - 1;
}
function typosquatOf(name) {
  const n = canonical(name);
  if (popular.has(n) || n.startsWith("@") || n.length < 5) return null;
  for (const part of n.split(/[-_.]/)) {
    if (/[a-z][013457][a-z]/.test(part)) {
      const unfolded = part.replace(/[013457]/g, (d) => leet[d] ?? d);
      if (brandSet.has(unfolded) && unfolded !== part) return unfolded;
    }
  }
  for (const p of popularList) {
    if (p.length < 5 || p.startsWith("@") || Math.abs(p.length - n.length) > 1) continue;
    if (slip(n, p)) return p;
  }
  return null;
}
var lureWords = /(?:^|[-_.])(?:crack|cracked|keygen|activator|aimbot|wallhack|injector|spoofer|stealer|grabber|drainer|robux|vbucks|nitro-?gen(?:erator)?|unlocker|airdrop-?claim)(?:$|[-_.])|(?:^|[-_.])free(?:[-_.][a-z0-9]+)*[-_.](?:pro|premium|plus|vip|nitro|license|activator)(?:$|[-_.])|(?:^|[-_.])(?:pro|premium|plus)[-_.]free(?:$|[-_.])/;
function isLurePackage(name) {
  return lureWords.test(name.toLowerCase());
}

// packages/intent/src/repos.ts
var famousOwners = new Set(
  `facebook facebookresearch meta-llama microsoft google google-research google-deepmind
    google-gemini googleapis vercel openai anthropics huggingface pytorch tensorflow torvalds
    rust-lang golang nodejs python apple aws awslabs kubernetes docker moby hashicorp ggerganov
    ggml-org ollama comfyanonymous automatic1111 lllyasviel oobabooga coqui-ai hexgrad suno-ai
    mozilla apache nvidia intel gitlab-org jetbrains sveltejs vuejs angular nestjs denoland oven-sh
    astral-sh pallets django tiangolo psf numpy pandas-dev scikit-learn matplotlib jupyter electron
    flutter dotnet homebrew ohmyzsh nvm-sh neovim vim git curl ffmpeg openssl postgres redis
    elastic grafana prometheus home-assistant supabase prisma tailwindlabs shadcn-ui langchain-ai
    run-llama ultralytics stability-ai black-forest-labs wan-video tencent deepseek-ai qwenlm
    mistralai vllm-project sgl-project xai-org lmstudio-ai invoke-ai unslothai expressjs webpack
    vitejs babel eslint prettier withastro remix-run solidjs preactjs nuxt storybookjs jestjs
    cypress-io puppeteer axios lodash fastify koajs socketio npm yarnpkg pnpm
    biomejs swc-project evanw rollup parcel-bundler gatsbyjs strapi tanstack trpc pmndrs reduxjs
    date-fns sindresorhus typicode cloudflare netlify tauri-apps ionic-team expo
    react-native-community software-mansion mui ant-design chakra-ui apollographql graphql encode
    pydantic python-poetry pypa pytest-dev pre-commit ansible scrapy celery explosion nltk
    streamlit gradio-app plotly pyca boto conda conda-forge mamba-org burntsushi sharkdp tokio-rs
    serde-rs clap-rs rust-lang-nursery alacritty wez helix-editor zellij-org nushell starship
    eza-community ajeetdsouza dandavison casey bevyengine rustdesk zed-industries pola-rs golangci
    spf13 gin-gonic gofiber labstack go-gorm junegunn jesseduffield charmbracelet cli gohugoio
    caddyserver traefik containerd etcd-io coredns cilium istio helm argoproj fluxcd rancher
    k3s-io kubernetes-sigs minio cockroachdb pingcap influxdata gravitational syncthing restic
    rclone go-gitea mattermost air-verse cosmtrek android googlesamples square
    kotlin spring-projects eclipse netflix alibaba reactivex swiftlang dart-lang julialang ziglang
    elixir-lang phoenixframework rails ruby rubygems laravel symfony php composer wordpress
    godotengine raysan5 ocornut libsdl-org glfw opencv keras-team jax-ml karpathy lm-sys nomic-ai
    mlc-ai ml-explore abetlen lightning-ai wandb mlflow ray-project dmlc github actions
    microsoftdocs azure azure-samples aws-samples pulumi nixos nix-community tmux zsh-users tpope
    folke nvim-lua nvim-treesitter lazyvim kovidgoyal ghostty-org mitchellh jqlang stedolan
    containers portainer nginx sqlite duckdb tursodatabase meilisearch typesense qdrant
    milvus-io chroma-core weaviate opentofu terraform-linters aquasecurity sigstore
    open-telemetry jaegertracing getsentry posthog calcom n8n-io appwrite pocketbase hasura
    nocodb directus excalidraw tldraw mermaid-js jgraph obsproject videolan audacity blender
    signalapp telegramdesktop bitwarden keepassxreboot`.split(/\s+/).filter(Boolean)
);
function repoOf(url) {
  const u = url.replace(/^git@([^:]+):/, "$1/").replace(/^[a-z+]+:\/\//i, "").replace(/^www\./, "").replace(/\.git$/, "").replace(/\/+$/, "");
  const [host = "", owner = "", name = ""] = u.split("/");
  const short = name ? `${host}/${owner}/${name}` : u;
  return { short: short.toLowerCase(), owner: owner.toLowerCase(), host: host.toLowerCase() };
}
function isFamousRepo(url) {
  return famousOwners.has(repoOf(url).owner);
}

// packages/intent/src/shell.ts
var maxDepth = 3;
var shellNames = /* @__PURE__ */ new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash"]);
var plainPrefixes = /* @__PURE__ */ new Set([
  "time",
  "nohup",
  "exec",
  "command",
  "builtin",
  "noglob",
  "then",
  "do",
  "else",
  "{",
  "}",
  "!",
  "caffeinate",
  "unbuffer",
  "stdbuf",
  "nice",
  "ionice",
  "chronic"
]);
var sudoValueFlags = /* @__PURE__ */ new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-U"]);
function heredocEnd(cmd, from, delim) {
  let at = from;
  while (at < cmd.length) {
    const nl = cmd.indexOf("\n", at);
    const end = nl === -1 ? cmd.length : nl;
    if (cmd.slice(at, end).trim() === delim) return { close: at, end };
    at = end + 1;
  }
  return { close: cmd.length, end: cmd.length };
}
function split(cmd) {
  const out = [];
  let words2 = [];
  let lives = [];
  let live = [];
  let redirects = [];
  let word = "";
  let inWord = false;
  let quote = null;
  let depth = 0;
  let subQuote = null;
  let target = null;
  let pipedFrom = false;
  let heredoc = null;
  let heredocQuoted = false;
  let heredocOwner = -1;
  let stdin = null;
  let stdinLive = [];
  const endWord = () => {
    if (inWord) {
      if (target === "out") redirects.push(word);
      else if (target === "here") {
        stdin = word;
        stdinLive = live;
      } else if (target === null) {
        words2.push(word);
        lives.push(live);
      }
      target = null;
    }
    word = "";
    live = [];
    inWord = false;
  };
  const endSeg = (pipe) => {
    endWord();
    if (words2.length > 0 || redirects.length > 0) {
      out.push({
        words: words2,
        live: lives,
        redirects,
        pipedFrom,
        pipesTo: pipe,
        stdin,
        stdinLive,
        stdinExpands: false
      });
      pipedFrom = pipe;
    } else if (!pipe) {
      pipedFrom = false;
    }
    words2 = [];
    lives = [];
    redirects = [];
    stdin = null;
    stdinLive = [];
  };
  const backtick = (i) => {
    const close = cmd.indexOf("`", i + 1);
    const end = close === -1 ? cmd.length : close;
    live.push(word.length);
    word += `$(${cmd.slice(i + 1, end)})`;
    return end;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const next = cmd[i + 1] ?? "";
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && '"\\$`'.includes(next)) {
        word += next;
        i++;
      } else if (c === "`") i = backtick(i);
      else {
        if (c === "$" && next === "(") live.push(word.length);
        word += c;
      }
      continue;
    }
    if (depth > 0) {
      word += c;
      if (subQuote) {
        if (c === subQuote) subQuote = null;
      } else if (c === "'" || c === '"') subQuote = c;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
      continue;
    }
    if (c === "\\") {
      if (next === "\n") i++;
      else if (/[\w.-]/.test(next)) {
        word += c;
        inWord = true;
      } else {
        word += next;
        inWord = true;
        i++;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
      continue;
    }
    if ((c === "$" || c === "<" || c === ">") && next === "(") {
      live.push(word.length);
      word += `${c}(`;
      inWord = true;
      depth = 1;
      i++;
      continue;
    }
    if (c === "`") {
      i = backtick(i);
      inWord = true;
      continue;
    }
    if (c === " " || c === "	" || c === "\r") {
      endWord();
      continue;
    }
    if (c === "\n") {
      endSeg(false);
      if (heredoc !== null) {
        const { close, end } = heredocEnd(cmd, i + 1, heredoc);
        const owner = out[heredocOwner];
        if (owner) {
          owner.stdin = cmd.slice(i + 1, close);
          owner.stdinExpands = !heredocQuoted;
        }
        i = end - 1;
        heredoc = null;
      }
      continue;
    }
    if (c === "#" && !inWord) {
      const nl = cmd.indexOf("\n", i);
      i = (nl === -1 ? cmd.length : nl) - 1;
      continue;
    }
    if (c === "(" && inWord) {
      word += c;
      continue;
    }
    if (c === ";" || c === "(" || c === ")") {
      endSeg(false);
      continue;
    }
    if (c === "&") {
      if (next === ">") {
        endWord();
        target = "out";
        i += cmd[i + 2] === ">" ? 2 : 1;
        continue;
      }
      if (next === "&") i++;
      endSeg(false);
      continue;
    }
    if (c === "|") {
      if (next === "|") {
        i++;
        endSeg(false);
      } else {
        if (next === "&") i++;
        endSeg(true);
      }
      continue;
    }
    if (c === ">" || c === "<") {
      if (/^\d+$/.test(word)) {
        word = "";
        inWord = false;
      }
      endWord();
      if (c === "<" && next === "<" && cmd[i + 2] === "<") {
        target = "here";
        i += 2;
        continue;
      }
      if (c === "<" && next === "<") {
        let j = i + 2;
        if (cmd[j] === "-") j++;
        const m = /^[ \t]*(\\?)(['"]?)([\w.-]{1,64})\2/.exec(cmd.slice(j, j + 80));
        if (m) {
          heredoc = m[3];
          heredocQuoted = m[1] !== "" || m[2] !== "";
          heredocOwner = out.length;
          i = j + m[0].length - 1;
        } else i = j - 1;
        continue;
      }
      if (c === ">" && (next === ">" || next === "|")) i++;
      if (c === ">" && cmd[i + 1] === "&") {
        i++;
        if (/\d|-/.test(cmd[i + 1] ?? "")) {
          i++;
          continue;
        }
      }
      target = c === ">" ? "out" : "in";
      continue;
    }
    word += c;
    inWord = true;
  }
  endSeg(false);
  return out;
}
function basename(p) {
  const b = p.split(/[\\/]/).pop() ?? p;
  return b.toLowerCase().replace(/\.exe$/, "");
}
function strip(words2) {
  let i = 0;
  let sudo = false;
  while (i < words2.length) {
    const w = words2[i];
    const lw = w.toLowerCase();
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i++;
    } else if (lw === "sudo" || lw === "doas" || lw === "run0" || lw === "pkexec") {
      sudo = true;
      i++;
      while (i < words2.length && words2[i].startsWith("-")) {
        i += sudoValueFlags.has(words2[i]) ? 2 : 1;
      }
    } else if (lw === "env") {
      i++;
      while (i < words2.length && /^(?:-|[A-Za-z_][A-Za-z0-9_]*=)/.test(words2[i])) {
        i += ["-u", "-C", "-S"].includes(words2[i]) ? 2 : 1;
      }
    } else if (lw === "timeout" || lw === "xargs" || lw === "watch") {
      i++;
      while (i < words2.length && words2[i].startsWith("-")) {
        i += /^-(?:[nIPsdkL]|-signal|-kill-after|-interval)$/.test(words2[i]) ? 2 : 1;
      }
      if (lw === "timeout" && i < words2.length) i++;
    } else if (plainPrefixes.has(lw)) {
      i++;
      while (i < words2.length && /^-/.test(words2[i])) {
        i += /^-[nc]$/.test(words2[i]) ? 2 : 1;
      }
    } else break;
  }
  return { rest: words2.slice(i), sudo, at: i };
}
function closeOf(w, at) {
  let d = 0;
  let end = at + 1;
  for (; end < w.length; end++) {
    if (w[end] === "(") d++;
    else if (w[end] === ")" && --d === 0) break;
  }
  return end;
}
function substitutions(w, starts) {
  const out = [];
  let after = 0;
  for (const at of starts) {
    if (at < after || !/[$<>]/.test(w[at] ?? "") || w[at + 1] !== "(") continue;
    const end = closeOf(w, at);
    out.push({ text: w.slice(at + 2, end), via: "subst", opener: w.slice(at, at + 2) });
    after = end + 1;
  }
  return out;
}
function expansions(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === "$" && text[i + 1] === "(") {
      const end = closeOf(text, i);
      out.push({ text: text.slice(i + 2, end), via: "subst", opener: "$(" });
      i = end;
    } else if (c === "`") {
      const close = text.indexOf("`", i + 1);
      if (close === -1) break;
      out.push({ text: text.slice(i + 1, close), via: "subst", opener: "$(" });
      i = close;
    }
  }
  return out;
}
function nested(argv, live, head) {
  const inner = [];
  argv.forEach((w, k) => {
    const found = substitutions(w, live[k] ?? []);
    if (k === 0 && found[0] && live[k]?.[0] === 0) found[0].asCommand = true;
    inner.push(...found);
  });
  const lowered = argv.map((a) => a.toLowerCase());
  const runsString = shellNames.has(head) || head === "powershell" || head === "pwsh" || head === "cmd" || head === "eval";
  if (runsString) {
    const flag = lowered.findIndex(
      (a, i) => head === "eval" ? i === 1 : /^(?:-c|-command|\/c|-[a-z]*c)$/.test(a) && i > 0
    );
    const target = head === "eval" ? 1 : flag + 1;
    const text = argv[target];
    if (flag !== -1 && text !== void 0) inner.push({ text, via: "string", opener: null });
  }
  return inner;
}
function parse(cmd, depth = 0, parent = null, via = null, opener = null) {
  const segs = [];
  const raws = split(cmd).map((raw) => {
    const { rest, sudo, at } = strip(raw.words);
    const argv = rest.length > 0 ? rest : raw.words;
    const live = rest.length > 0 ? raw.live.slice(at) : raw.live;
    return { raw, argv, live, sudo, head: basename(argv[0] ?? "") };
  });
  raws.forEach(({ raw, argv, live, sudo, head }, i) => {
    segs.push({
      argv,
      lower: argv.map((a) => a.toLowerCase()),
      head,
      sudo,
      redirects: raw.redirects,
      pipedFrom: raw.pipedFrom,
      pipesTo: raw.pipesTo,
      parent,
      via,
      opener,
      stdin: raw.stdin
    });
    if (depth >= maxDepth) return;
    const inner = nested(argv, live, head);
    if (raw.stdin !== null && raw.stdinLive.length > 0)
      inner.push(...substitutions(raw.stdin, raw.stdinLive));
    else if (raw.stdin !== null && raw.stdinExpands && !shellNames.has(head))
      inner.push(...expansions(raw.stdin));
    if (raw.stdin !== null && shellNames.has(head))
      inner.push({ text: raw.stdin, via: "string", opener: null });
    const sink = raw.pipesTo ? raws[i + 1]?.head : void 0;
    if (sink && shellNames.has(sink) && /^(?:echo|printf|cat)$/.test(head)) {
      const text = head === "cat" ? raw.stdin : argv.slice(1).join(" ");
      if (text) segs.push(...parse(text, depth + 1, sink, "string"));
    }
    const runner = via === "string" && parent !== null ? parent : "eval";
    for (const n of inner) {
      const owner = n.asCommand ? runner : head;
      segs.push(...parse(n.text, depth + 1, owner, n.via, n.opener));
    }
  });
  return segs;
}

// packages/intent/src/score.ts
var suggestPoints = 4;
var fullPoints = 8;
var threshold = suggestPoints / fullPoints;
var none = {
  suggest: false,
  score: 0,
  category: null,
  signals: [],
  subject: null
};
var priority = [
  "untrusted_code",
  "risky_experiment",
  "local_ai_model",
  "environment",
  "heavy_compute"
];
function hit(id, category, weight, evidence2, subject) {
  return {
    id,
    category,
    weight,
    evidence: evidence2.trim().slice(0, 80),
    subject: subject?.slice(0, 120)
  };
}
function leading(hits) {
  const sums = /* @__PURE__ */ new Map();
  for (const h of hits) {
    if (h.category && h.weight > 0)
      sums.set(h.category, (sums.get(h.category) ?? 0) + h.weight);
  }
  let best = null;
  let bestSum = 0;
  for (const c of priority) {
    const s = sums.get(c) ?? 0;
    if (s > bestSum) {
      best = c;
      bestSum = s;
    }
  }
  return best;
}
function leadOf(hits, category) {
  let best;
  for (const h of hits) {
    if (h.category !== category || h.weight <= 0) continue;
    const tieWithName = best && h.weight === best.weight && !best.subject && h.subject;
    if (!best || h.weight > best.weight || tieWithName) best = h;
  }
  return best;
}
function signals(hits, category, lead2) {
  const rest = hits.filter((h) => h !== lead2).sort((a, b) => b.weight - a.weight);
  return (lead2 ? [lead2, ...rest] : rest).map((h) => ({
    id: h.id,
    category: h.category ?? category,
    weight: h.weight,
    evidence: h.evidence
  }));
}
function finish(hits, points, live = hits) {
  if (hits.length === 0) return none;
  const pool = live.some((h) => h.category && h.weight > 0) ? live : hits;
  const positive = hits.some((h) => h.weight > 0);
  const category = leading(pool) ?? (positive ? "untrusted_code" : null);
  const total = points ?? hits.reduce((s, h) => s + h.weight, 0);
  const score = Math.max(0, Math.min(1, total / fullPoints));
  const lead2 = leadOf(pool, category);
  return {
    suggest: category !== null && total >= suggestPoints,
    score: Math.round(score * 1e3) / 1e3,
    category,
    signals: signals(hits, category ?? "untrusted_code", lead2),
    subject: lead2?.subject ?? null
  };
}
function refuse(hits, policy2) {
  const category = leading(hits);
  const lead2 = leadOf(hits, category);
  return {
    suggest: false,
    score: 0,
    category,
    signals: signals([policy2, ...hits], category ?? "risky_experiment", policy2),
    subject: lead2?.subject ?? null
  };
}

// packages/intent/src/command.ts
var fetchers = /* @__PURE__ */ new Set([
  "curl",
  "wget",
  "iwr",
  "irm",
  "invoke-webrequest",
  "invoke-restmethod",
  "aria2c",
  "http",
  "xh"
]);
var interpreters = /* @__PURE__ */ new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "ash",
  "python",
  "python3",
  "python2",
  "perl",
  "ruby",
  "node",
  "php",
  "iex",
  "invoke-expression",
  "pwsh",
  "powershell",
  "source",
  ".",
  "eval"
]);
var readOnly2 = /* @__PURE__ */ new Set([
  "grep",
  "egrep",
  "rg",
  "ag",
  "ls",
  "ll",
  "cat",
  "bat",
  "less",
  "more",
  "head",
  "tail",
  "wc",
  "file",
  "stat",
  "du",
  "df",
  "tree",
  "echo",
  "printf",
  "which",
  "type",
  "whereis",
  "man",
  "diff",
  "jq",
  "yq",
  "awk",
  "sed",
  "sort",
  "uniq",
  "cut",
  "tr",
  "find",
  "fd",
  "pwd",
  "cd",
  "pushd",
  "popd",
  "export",
  "set",
  "unset",
  "alias",
  "history",
  "true",
  "false",
  "test",
  "[",
  "read",
  "sleep",
  "clear",
  "open",
  "code",
  "tee",
  "touch",
  "mkdir",
  "cp",
  "mv",
  "ln",
  "chmod",
  "nvm",
  "pyenv",
  "deactivate",
  "activate"
]);
var mainstream = [
  "brew.sh",
  "raw.githubusercontent.com/homebrew/",
  "sh.rustup.rs",
  "rustup.rs",
  "win.rustup.rs",
  "bun.sh/install",
  "get.docker.com",
  "deno.land/install.sh",
  "deno.land/install.ps1",
  "deno.land/x/install/",
  "deno.land/std/",
  "deno.land/std@",
  "jsr.io/@std/",
  "astral.sh/uv",
  "astral.sh/ruff",
  "raw.githubusercontent.com/nvm-sh/nvm/",
  "raw.githubusercontent.com/ohmyzsh/",
  "get.pnpm.io",
  "fnm.vercel.app",
  "get.volta.sh",
  "starship.rs",
  "claude.ai/install",
  "tailscale.com/install",
  "install.python-poetry.org",
  "pyenv.run",
  "mise.run",
  "get.sdkman.io",
  "install.determinate.systems",
  "nixos.org/nix/install",
  "dot.net/v1/dotnet-install",
  "deb.nodesource.com/",
  "rpm.nodesource.com/",
  "get.scoop.sh",
  "community.chocolatey.org/install",
  "chocolatey.org/install",
  "fly.io/install",
  "cli.github.com",
  "sdk.cloud.google.com",
  "raw.githubusercontent.com/helm/helm/",
  "get.helm.sh",
  "opencode.ai/install",
  "cursor.com/install",
  "gh.io/copilot-install"
];
function looksLikeUrl(w) {
  return /^(?:https?|ftp):\/\//i.test(w) || /^[\w-]+(?:\.[\w-]+)+\/\S*/.test(w) || /^[\w-]+\.[\w-]+\.[a-z]{2,}$/i.test(w);
}
function hostPath(url) {
  return url.toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "");
}
var mainstreamHosts = [
  "astral.sh",
  "rustup.rs",
  "bun.sh",
  "brew.sh",
  "volta.sh",
  "pnpm.io",
  "docker.com",
  "nodesource.com",
  "tailscale.com",
  "starship.rs",
  "claude.ai",
  "anthropic.com",
  "python-poetry.org",
  "pyenv.run",
  "mise.run",
  "sdkman.io",
  "determinate.systems",
  "nixos.org",
  "scoop.sh",
  "chocolatey.org",
  "fly.io",
  "helm.sh",
  "go.dev",
  "golang.org",
  "nodejs.org",
  "yarnpkg.com",
  "julialang.org",
  "k3s.io",
  "rvm.io",
  "bootstrap.pypa.io",
  "vercel.com",
  "netlify.com",
  "supabase.com",
  "cloud.google.com",
  "dl.google.com",
  "awscli.amazonaws.com",
  "releases.hashicorp.com",
  "packages.microsoft.com",
  "aka.ms"
];
function resolved(path) {
  const cut = path.search(/[?#]/);
  const parts = (cut === -1 ? path : path.slice(0, cut)).replace(/%2e/gi, ".").split("/");
  const out = [];
  parts.slice(1).forEach((part, k) => {
    if (part === "..") out.pop();
    else if (part !== ".") out.push(part);
    if ((part === ".." || part === ".") && k === parts.length - 2) out.push("");
  });
  return `/${out.join("/")}`;
}
function isMainstream(url) {
  const hp = hostPath(url);
  const cut = hp.search(/[/?#]/);
  const host = (cut === -1 ? hp : hp.slice(0, cut)).replace(/:\d+$/, "");
  const path = cut === -1 ? "/" : resolved(hp.slice(cut));
  return mainstream.some((m) => {
    const slash = m.indexOf("/");
    if (slash === -1) return host === m;
    return host === m.slice(0, slash) && path.startsWith(m.slice(slash));
  }) || mainstreamHosts.some((m) => host === m || host.endsWith(`.${m}`));
}
function urlArg(seg) {
  return seg.argv.slice(1).find(looksLikeUrl) ?? null;
}
function fetchedUrl(seg) {
  const urls = seg.argv.slice(1).filter(looksLikeUrl);
  return urls.find((u) => !isMainstream(u)) ?? urls[0] ?? null;
}
function add(st, h) {
  const same = (x) => x.id === h.id && x.evidence === h.evidence && x.subject === h.subject;
  if (!st.hits.some(same)) st.hits.push(h);
}
function evidence(seg, words2 = 4) {
  return seg.argv.slice(0, words2).join(" ");
}
function isLocal(target) {
  return privateTarget.test(hostPath(target));
}
function remoteExec(segs, i, st) {
  const seg = segs[i];
  let url = null;
  let how = "";
  let sink;
  const last = Math.min(segs.length, i + 6);
  for (let j = i + 1; fetchers.has(seg.head) && seg.pipesTo && j < last && segs[j]?.pipedFrom; j++) {
    if (interpreters.has(segs[j].head)) {
      sink = segs[j];
      break;
    }
    if (!segs[j].pipesTo) break;
  }
  if (fetchers.has(seg.head) && sink) {
    url = fetchedUrl(seg);
    how = `${seg.head} | ${sink.head}`;
  } else if (fetchers.has(seg.head) && seg.via === "subst" && seg.parent !== null && interpreters.has(seg.parent)) {
    url = fetchedUrl(seg);
    how = `${seg.parent} ${seg.opener ?? "$("}${seg.head})`;
  } else if (seg.head === "iex" || seg.head === "invoke-expression") {
    const m = /(https?:\/\/[^\s'")]+)/i.exec(seg.argv.join(" "));
    if (m && /downloadstring|iwr|irm|invoke-web|invoke-rest|webclient/i.test(seg.argv.join(" "))) {
      url = m[1];
      how = "iex download";
    }
  }
  if (how === "") return;
  if (url && isMainstream(url)) {
    add(st, hit("mainstream_installer", null, 0, hostPath(url).slice(0, 60)));
    return;
  }
  if (url && /ollama\.com\/install/i.test(url)) {
    add(st, hit("ai_runtime_install", "local_ai_model", 2, "ollama install script", "Ollama"));
    return;
  }
  const subject = url ? hostPath(url).split("?")[0] : "a script from the internet";
  add(st, hit("pipe_to_shell", "untrusted_code", 6, how, subject));
}
function decodedExec(segs, i, st) {
  const seg = segs[i];
  const l = seg.lower;
  const decodes = seg.head === "base64" && l.some((a) => /^(?:-d|--decode|-di)$/.test(a)) || seg.head === "openssl" && l.includes("base64") && l.includes("-d") || seg.head === "xxd" && l.some((a) => /^-r/.test(a));
  if (!decodes) return;
  let sink = null;
  const last = Math.min(segs.length, i + 4);
  for (let j = i + 1; seg.pipesTo && j < last && segs[j]?.pipedFrom; j++) {
    if (interpreters.has(segs[j].head)) {
      sink = segs[j].head;
      break;
    }
    if (!segs[j].pipesTo) break;
  }
  if (!sink && seg.via === "subst" && seg.parent !== null && interpreters.has(seg.parent))
    sink = seg.parent;
  if (sink) {
    add(
      st,
      hit(
        "decoded_exec",
        "untrusted_code",
        6,
        `${seg.head} -d | ${sink}`,
        "an encoded script"
      )
    );
  }
}
var scriptHosts = /^(?:python[\d.]*|py|node|deno|bun|perl|ruby|php)$/;
var codeExec = /\b(?:exec|eval|execfile|runpy\.run_\w+|new function|vm\.run\w*|instance_eval|class_eval)\b(?!\s*\(\s*['"`])/;
var processRun = /\b(?:system|popen|subprocess|spawn\w*|execsync|exec|child_process|shell_exec|passthru)\b/;
var fetchCall = /\b(?:urlopen|urlretrieve|requests|httpx|urllib|fetch|https?\.get|axios|curl|wget|net::http|open-uri|lwp|file_get_contents)\b/;
var writesFile = /urlretrieve|\.write(?:_bytes)?\(|writefile\w*|createwritestream|copyfileobj|chmod|file_put_contents/;
function inlineCode(seg, st) {
  if (!scriptHosts.test(seg.head)) return;
  const flag = seg.lower.findIndex((a, j) => j > 0 && /^-(?:c|e|-eval|r|p)$/.test(a));
  const code = (flag !== -1 ? seg.argv[flag + 1] : seg.stdin)?.toLowerCase();
  if (!code) return;
  const url = /https?:\/\/[^\s'"()]+/.exec(code)?.[0];
  const remote = url !== void 0 && fetchCall.test(code) && !isMainstream(url);
  const piped = /\b(?:curl|wget)\b[^'"\n]{0,300}\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/.test(code);
  const runsDownload = codeExec.test(code) || processRun.test(code) && (piped || writesFile.test(code));
  if (remote && runsDownload) {
    add(
      st,
      hit(
        "inline_remote_exec",
        "untrusted_code",
        codeExec.test(code) || piped ? 6 : 5,
        `${seg.head} inline code`,
        hostPath(url)
      )
    );
  } else if ((codeExec.test(code) || processRun.test(code)) && /b64decode|base64|atob|frombase64string|fromcharcode|codecs\.decode/.test(code)) {
    add(
      st,
      hit(
        "decoded_exec",
        "untrusted_code",
        5,
        `${seg.head} decodes and runs`,
        "an encoded script"
      )
    );
  }
}
function policyBypass(seg, st) {
  const l = seg.lower;
  if (seg.head === "set-executionpolicy") {
    if (l.some((a) => a === "bypass" || a === "unrestricted"))
      add(st, hit("policy_bypass", "untrusted_code", 2, "Set-ExecutionPolicy Bypass"));
    return;
  }
  if (seg.head !== "powershell" && seg.head !== "pwsh") return;
  const at = l.findIndex((a) => /^-(?:executionpolicy|exec\w*|ep|ex)$/.test(a));
  if (at === -1 || !/^(?:bypass|unrestricted)$/.test(l[at + 1] ?? "")) return;
  const fileAt = l.findIndex((a) => a === "-file" || a === "-f");
  const script = fileAt !== -1 ? seg.argv[fileAt + 1] : seg.argv.find((a) => /\.ps1$/i.test(a));
  const risky = script !== void 0 && (/(?:^|[\\/])(?:install|setup|bootstrap|get)[\w-]*\.ps1$/i.test(script) || /downloads|temp|appdata/i.test(script) || st.cloned || st.ctx.clonedThisSession === true);
  const w = script === void 0 ? 2 : risky ? 4 : 3;
  add(st, hit("policy_bypass", "untrusted_code", w, "-ExecutionPolicy Bypass", script));
}
var pathKey = (p) => p.replace(/\\/g, "/").replace(/^\.\//, "");
function ranFile(seg) {
  if (!interpreters.has(seg.head) && !scriptHosts.test(seg.head)) return seg.argv[0];
  return seg.argv.slice(1).find((a) => !a.startsWith("-"));
}
function withWritten(segs) {
  const written = /* @__PURE__ */ new Map();
  const read = /* @__PURE__ */ new Set();
  const out = [];
  for (const seg of segs) {
    const tee = seg.head === "tee" ? seg.argv.slice(1).find((a) => !a.startsWith("-")) : null;
    const target = seg.redirects[0] ?? tee;
    const text = /^(?:cat|tee)$/.test(seg.head) ? seg.stdin : /^(?:echo|printf)$/.test(seg.head) ? seg.argv.slice(1).join(" ") : null;
    if (target && text) {
      written.set(pathKey(target), text);
      read.delete(pathKey(target));
    }
    const run = ranFile(seg);
    const key = run && !target ? pathKey(run) : "";
    const body = key && !read.has(key) ? written.get(key) : void 0;
    if (body !== void 0) read.add(key);
    if (body === void 0) {
      out.push(seg);
    } else if (scriptHosts.test(seg.head)) {
      out.push({ ...seg, stdin: body });
    } else {
      out.push(seg, ...parse(body, 1, seg.head, "string"));
    }
  }
  return out;
}
function outputAt(seg) {
  if (seg.head === "wget")
    return seg.argv.findIndex((a) => /^(?:-[a-zA-Z]*O|--output-document)$/.test(a));
  return seg.argv.findIndex(
    (a) => /^(?:-[a-zA-Z]*o|--output|-outfile)$/i.test(a) && !/O$/.test(a)
  );
}
function downloadThenRun(seg, st) {
  if (fetchers.has(seg.head)) {
    const url = urlArg(seg);
    const named2 = (url ?? "").split(/[?#]/)[0]?.split("/").pop() ?? "";
    const at = outputAt(seg);
    const remoteName = seg.head === "wget" ? at === -1 : seg.argv.some((a) => /^-[a-zA-Z]*O[a-zA-Z]*$|^--remote-name(?:-all)?$/.test(a));
    const out = at !== -1 ? seg.argv[at + 1] : seg.redirects[0];
    if (out && !out.startsWith("-")) st.downloads.add(pathKey(out));
    else if (remoteName && named2) st.downloads.add(named2);
    return;
  }
  if (st.downloads.size === 0) return;
  const runs = ranFile(seg);
  if (runs && st.downloads.has(pathKey(runs))) {
    add(st, hit("download_then_run", "untrusted_code", 5, evidence(seg), runs));
  }
}
var cloneValueFlags = /^(?:--depth|-b|--branch|--origin|-o|--filter|--config|-c|--jobs|-j|--reference|--separate-git-dir|--template|--shallow-since|--shallow-exclude|-u|--upload-pack)$/;
function cloneOf(seg) {
  let url = null;
  let dir;
  if (seg.head === "git") {
    const at = seg.lower.indexOf("clone");
    if (at === -1) return null;
    const rest = [];
    for (let j = at + 1; j < seg.argv.length; j++) {
      const a = seg.argv[j];
      if (cloneValueFlags.test(a)) j++;
      else if (!a.startsWith("-")) rest.push(a);
    }
    [url = null, dir] = rest;
  } else if (seg.head === "gh" && seg.lower[1] === "repo" && seg.lower[2] === "clone") {
    const target = seg.argv[3];
    if (target)
      url = target.includes("/") && !target.includes(":") ? `github.com/${target}` : target;
    dir = seg.argv[4];
  }
  if (!url || !/^(?:https?:\/\/|git@|ssh:\/\/|git:\/\/|[\w.-]+\.[a-z]{2,}\/)/i.test(url))
    return null;
  const name = url.replace(/\.git$/, "").replace(/\/+$/, "").split(/[/:]/).pop();
  return { url, dir: dir ?? name ?? "" };
}
function clonesIn(command) {
  const out = [];
  for (const seg of parse(ascii(clip(command)).trim())) {
    const c = cloneOf(seg);
    if (c && c.dir) out.push({ repo: repoOf(c.url).short, dir: c.dir });
  }
  return out;
}
function gitClone(seg, st) {
  const url = cloneOf(seg)?.url;
  if (!url) return;
  const repo = repoOf(url);
  st.cloned = true;
  st.clonedRepo = repo.short;
  st.clonedFamous = famousOwners.has(repo.owner);
  if (repo.host === "huggingface.co") {
    add(
      st,
      hit("model_repo_clone", "local_ai_model", 4, "git clone huggingface.co", repo.short)
    );
    return;
  }
  if (!st.clonedFamous) add(st, hit("git_clone", "untrusted_code", 2, "git clone", repo.short));
}
function projectStep(seg) {
  const [h, a1 = "", a2 = ""] = [seg.head, seg.lower[1], seg.lower[2]];
  const prog = seg.argv[0] ?? "";
  if (["npm", "pnpm", "yarn", "bun"].includes(h)) {
    if (h === "yarn" && a1 === "") return "yarn";
    if (/^(?:install|i|ci|add|start|run|run-script|dev|test|t|exec|build|rebuild|link|x)$/.test(
      a1
    )) {
      return `${h} ${a1}`;
    }
    return null;
  }
  if (h === "pip" || h === "pip3" || h === "uv" && a1 === "pip") {
    const args = h === "uv" ? seg.lower.slice(2) : seg.lower.slice(1);
    if (args[0] !== "install") return null;
    if (args.some(
      (a) => a === "-r" || a === "-e" || a === "." || a === "--editable" || /^-r\S/.test(a) || /requirements[\w.-]*\.txt$/.test(a)
    )) {
      return `${h} install -r`;
    }
    return null;
  }
  if (/^python[\d.]*$|^py$/.test(h)) {
    if (a1 === "-m" && /^(?:pip|venv|virtualenv|http\.server|json\.tool)$/.test(a2)) {
      return a2 === "pip" && seg.lower.includes("-r") ? "python -m pip install -r" : null;
    }
    if (a1 && !a1.startsWith("-")) return `python ${seg.argv[1]}`;
    if (a1 === "-m" && a2) return `python -m ${a2}`;
    return null;
  }
  if (["uv", "poetry", "pipenv", "pdm", "rye", "hatch"].includes(h)) {
    return /^(?:sync|install|run|add)$/.test(a1) ? `${h} ${a1}` : null;
  }
  if ((h === "conda" || h === "mamba" || h === "micromamba") && a1 === "env" && a2 === "create") {
    return `${h} env create`;
  }
  if (["node", "deno", "tsx", "ts-node", "bunx", "npx"].includes(h) && a1 !== "" && !a1.startsWith("-v")) {
    return `${h} ${seg.argv[1]}`;
  }
  if (["make", "cmake", "meson", "ninja", "gradle", "mvn", "just", "scons", "bazel"].includes(h))
    return h;
  if (h === "cargo" && /^(?:build|run|install|test|bench)$/.test(a1)) return `cargo ${a1}`;
  if (h === "go" && /^(?:run|build|install|generate|test)$/.test(a1)) return `go ${a1}`;
  if (h === "dotnet" && /^(?:run|build|restore)$/.test(a1)) return `dotnet ${a1}`;
  if ((h === "docker" || h === "podman") && (a1 === "build" || a1 === "compose" && /^(?:up|build|run)$/.test(a2))) {
    return `${h} ${a1}`;
  }
  if (h === "docker-compose" && /^(?:up|build|run)$/.test(a1)) return "docker-compose up";
  if (/^\.\.?\//.test(prog) || ["sh", "bash", "zsh"].includes(h) && /\.(?:sh|bash)$/.test(a1)) {
    return seg.argv.slice(0, 2).join(" ");
  }
  return null;
}
function clonedCode(seg, st) {
  if (st.ranClonedCode || !(st.cloned || st.ctx.clonedThisSession)) return;
  const step = projectStep(seg);
  if (!step) return;
  st.ranClonedCode = true;
  const repo = st.clonedRepo ?? (st.ctx.clonedRepo ? repoOf(st.ctx.clonedRepo).short : null);
  const famous = st.cloned ? st.clonedFamous : repo !== null && isFamousRepo(repo);
  add(st, hit("runs_cloned_code", "untrusted_code", famous ? 2 : 5, step, repo ?? void 0));
  if (repo && find(aiName, spaced(repo))) {
    add(st, hit("ai_repo", "local_ai_model", 4, step, repo));
  }
}
var pipValueFlags = /^(?:-r|--requirement|-c|--constraint|-e|--editable|-i|--index-url|--extra-index-url|-f|--find-links|-t|--target|--prefix|--root|--platform|--python-version|--implementation|--abi|--src|--cache-dir|--log|--trusted-host|--python|-p|--group|--only-binary|--no-binary)$/;
function packageName(spec) {
  return spec.replace(/^['"]|['"]$/g, "").split(/[\s;]/)[0].replace(/\[.*$/, "").split(/(?:===?|>=|<=|~=|!=|<|>)/)[0].trim();
}
function install(seg) {
  const h = seg.head;
  const l = seg.lower;
  let args = null;
  let manager = "pip";
  if ((h === "pip" || h === "pip3" || h === "pipx") && l[1] === "install")
    args = seg.argv.slice(2);
  else if (h === "uv" && l[1] === "pip" && l[2] === "install") args = seg.argv.slice(3);
  else if (h === "uv" && (l[1] === "add" || l[1] === "tool" && l[2] === "install")) {
    args = seg.argv.slice(l[1] === "add" ? 2 : 3);
  } else if (/^python[\d.]*$/.test(h) && l[1] === "-m" && l[2] === "pip" && l[3] === "install") {
    args = seg.argv.slice(4);
  } else if ((h === "poetry" || h === "pdm") && l[1] === "add") args = seg.argv.slice(2);
  else if (["conda", "mamba", "micromamba"].includes(h) && l[1] === "install") {
    args = seg.argv.slice(2);
    manager = "conda";
  } else if (["npm", "pnpm", "yarn", "bun"].includes(h) && /^(?:install|i|add)$/.test(l[1] ?? "")) {
    args = seg.argv.slice(2);
    manager = "npm";
  } else if (["npx", "bunx", "uvx"].includes(h) || ["pnpm", "yarn"].includes(h) && l[1] === "dlx") {
    const rest = seg.argv.slice(h === "npx" || h === "bunx" || h === "uvx" ? 1 : 2);
    const first = rest.find((a) => !a.startsWith("-"));
    args = first ? [first] : [];
    manager = h === "uvx" ? "pip" : "npm";
  } else if (h === "brew" && l[1] === "install") {
    args = seg.argv.slice(2);
    manager = "brew";
  } else if (["apt", "apt-get", "dnf", "yum", "zypper", "pacman", "apk"].includes(h)) {
    if (!/^(?:install|-s|-syu|-sy|add)$/.test(l[1] ?? "")) return null;
    args = seg.argv.slice(2);
    manager = "system";
  }
  if (args === null) return null;
  const out = {
    manager,
    names: [],
    urlDeps: [],
    indexUrls: [],
    global: false,
    breakSystem: false
  };
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    const la = a.toLowerCase();
    if (la === "-g" || la === "--global" || la === "--user") out.global ||= la !== "--user";
    if (la === "--break-system-packages") out.breakSystem = true;
    if (/^(?:-i|--index-url|--extra-index-url)$/.test(la))
      out.indexUrls.push(args[j + 1] ?? "");
    if (/^--(?:extra-)?index-url=/.test(la)) out.indexUrls.push(a.split("=")[1] ?? "");
    if (manager === "pip" && pipValueFlags.test(la)) {
      j++;
      continue;
    }
    if (a.startsWith("-")) continue;
    if (/^(?:git\+|https?:\/\/|github:|gitlab:|file:)/i.test(a) || /\.(?:whl|tar\.gz|zip|tgz)$/i.test(a)) {
      out.urlDeps.push(a);
      continue;
    }
    if (a === "." || a.startsWith("./") || a.startsWith("/")) continue;
    const name = manager === "npm" ? a.startsWith("@") ? a.split("@").slice(0, 2).join("@") : a.split("@")[0] : packageName(a);
    if (name) out.names.push(name);
  }
  return out;
}
var driverPackage = /^(?:[\w.+-]*(?:nvidia|cuda|cudnn)[\w.+-]*|linux-headers[\w.-]*|[\w.-]+-dkms|dkms)$/;
function packages(seg, st) {
  const inst = install(seg);
  if (!inst) return;
  const ctx = st.ctx;
  const names = inst.names;
  const shown = names.slice(0, 3).join(" ");
  if (inst.manager === "system") {
    const drivers2 = names.filter((n) => driverPackage.test(n.toLowerCase()));
    if (drivers2.length > 0) {
      add(
        st,
        hit(
          "gpu_driver_install",
          "environment",
          5,
          `${seg.head} install ${drivers2.slice(0, 2).join(" ")}`,
          drivers2[0]
        )
      );
    }
    return;
  }
  if (inst.manager === "brew") {
    const ai = names.find(
      (n) => /^(?:ollama|llama\.cpp|whisper-cpp|lm-studio|comfyui)$/i.test(n)
    );
    if (ai) add(st, hit("ai_runtime_install", "local_ai_model", 2, `brew install ${ai}`, ai));
    return;
  }
  let best = null;
  const groups = /* @__PURE__ */ new Set();
  const nvidia = [];
  for (const n of names) {
    const hp = heavyPackage(n);
    if (hp) {
      groups.add(hp.group);
      if (hp.nvidiaOnly) nvidia.push(n);
      if (!best || hp.weight > best.weight) best = { name: n, weight: hp.weight };
    }
  }
  if (best) {
    let w = best.weight + (groups.size >= 2 ? 1 : 0);
    if (groups.has("torch") && ctx.os === "linux" && !inst.indexUrls.some((u) => /\/cpu\b/.test(u)))
      w += 1;
    add(
      st,
      hit(
        "heavy_ml_install",
        "local_ai_model",
        Math.min(w, 6),
        `${seg.head} install ${shown}`,
        best.name
      )
    );
  }
  if (nvidia.length > 0 && (ctx.os === "macos" || ctx.os === "windows")) {
    add(
      st,
      hit("nvidia_only_package", "environment", 2, nvidia.slice(0, 2).join(" "), nvidia[0])
    );
  }
  if (inst.indexUrls.some((u) => /download\.pytorch\.org\/whl\/cu\d+/i.test(u))) {
    add(st, hit("cuda_wheels", "environment", 1, "pytorch cuda index"));
  }
  for (const n of names) {
    const squat = typosquatOf(n);
    if (squat) {
      add(st, hit("typosquat_package", "untrusted_code", 5, `${n} looks like ${squat}`, n));
      break;
    }
    if (isLurePackage(n)) {
      add(st, hit("lure_package", "untrusted_code", 5, n, n));
      break;
    }
  }
  const dep = inst.urlDeps[0];
  if (dep) {
    const repo = /github|gitlab|bitbucket|codeberg/i.test(dep) ? repoOf(dep.replace(/^git\+/, "")) : null;
    const w = repo && famousOwners.has(repo.owner) ? 2 : 4;
    add(st, hit("url_dependency", "untrusted_code", w, dep, repo?.short ?? dep));
  }
  const odd = inst.indexUrls.find(
    (u) => u && !/^https:\/\/(?:pypi\.org|download\.pytorch\.org|test\.pypi\.org)/i.test(u)
  );
  if (odd) add(st, hit("foreign_index", "untrusted_code", 3, odd, odd));
  if (inst.manager === "pip" && seg.sudo) {
    const whole = seg.lower.some((a) => a === "-r" || /requirements[\w.-]*\.txt$/.test(a));
    add(st, hit("sudo_pip", "environment", whole ? 4 : 3, "sudo pip install"));
  }
  if (inst.breakSystem)
    add(st, hit("break_system_packages", "environment", 3, "--break-system-packages"));
  if (inst.manager === "npm" && inst.global && seg.sudo)
    add(st, hit("sudo_global_npm", "environment", 1, "sudo npm -g"));
}
function remoteBuild(seg, st) {
  const h = seg.head;
  const l = seg.lower;
  let target;
  if (h === "go" && l[1] === "install") {
    target = seg.argv.slice(2).find((a) => /^[\w.-]+\.[a-z]+\/[\w.-]+\/[\w.-]+/.test(a));
  } else if (h === "cargo" && l[1] === "install" && l.includes("--git")) {
    target = seg.argv[l.indexOf("--git") + 1];
  } else if (h === "deno" && l[1] === "run") {
    target = seg.argv.slice(2).find((a) => /^https?:\/\//i.test(a));
  }
  if (!target) return;
  const repo = repoOf(target.split("@")[0]);
  if (famousOwners.has(repo.owner) || isMainstream(target)) return;
  add(st, hit("remote_build", "untrusted_code", 4, evidence(seg, 3), repo.short));
}
function modelWeight(id) {
  const s = spaced(id.toLowerCase());
  const size = /(?<![\w.])(\d{1,3}(?:\.\d)?) ?b(?![a-z])/.exec(s);
  if (size && Number(size[1]) >= 13) return 2;
  if (/(?<![a-z])(?:minilm|mpnet|bge|e5|gte|bert|distil\w*|tiny\w*|small|mini|nano|embed\w*|t5 small)(?![a-z])/.test(
    s
  ))
    return 0;
  if (/(?<![a-z])(?:flux|stable diffusion|sdxl|sd3|wan2|wan|hunyuan\w*|ltx\w*|cogvideo\w*|mochi|whisper large\w*|large v\d|xtts\w*|bark|llama|mistral|mixtral|qwen\w*|deepseek\w*|gemma|phi|falcon|yi|codellama|starcoder\w*)(?![a-z])/.test(
    s
  ))
    return 1;
  if (size && Number(size[1]) >= 7) return 1;
  return 0;
}
function models(seg, st) {
  const h = seg.head;
  const l = seg.lower;
  if ((h === "huggingface-cli" || h === "hf") && l[1] === "download" && seg.argv[2]) {
    const id2 = seg.argv[2];
    add(st, hit("model_download", "local_ai_model", 3 + modelWeight(id2), `${h} download`, id2));
    return;
  }
  if (h === "ollama" && (l[1] === "pull" || l[1] === "run") && seg.argv[2]) {
    const tag = seg.argv[2];
    const size = /(\d{1,3}(?:\.\d)?)b\b/i.exec(tag);
    const w = size ? Number(size[1]) >= 13 ? 2 : Number(size[1]) <= 4 ? -1 : 0 : 0;
    add(st, hit("model_download", "local_ai_model", 3 + w, `ollama ${l[1]}`, tag));
    return;
  }
  if (h === "git-lfs" || h === "git" && l[1] === "lfs" && /^(?:pull|fetch|clone)$/.test(l[2] ?? "")) {
    add(st, hit("lfs_pull", "local_ai_model", 2, "git lfs pull", st.clonedRepo ?? void 0));
    return;
  }
  if (fetchers.has(h)) {
    const url = urlArg(seg) ?? "";
    if (/huggingface\.co\/[^\s]+\/(?:resolve|blob)\/|civitai\.com\/api\/download|\.(?:safetensors|gguf|ckpt|pth)(?:\?|$)/i.test(
      url
    )) {
      add(
        st,
        hit(
          "weights_download",
          "local_ai_model",
          4,
          `${h} ${hostPath(url).slice(0, 40)}`,
          hostPath(url).split("/").slice(0, 3).join("/")
        )
      );
    }
    return;
  }
  const script = scriptOf(seg);
  if (script && /download[\s_-]?(?:all[\s_-]?)?(?:models?|weights|checkpoints?|ckpts?)|(?:get|fetch)[\s_-](?:models?|weights)|download[\s_-]ggml[\s_-]model/i.test(
    script
  )) {
    add(st, hit("model_download_script", "local_ai_model", 4, evidence(seg), script));
    return;
  }
  const id = hubModelArg(seg);
  if (id) add(st, hit("hub_model", "local_ai_model", 3 + modelWeight(id), `--model ${id}`, id));
}
var modelFlag = /^--?(?:model|model[-_]name|model[-_]id|model[-_]path|model[-_]name[-_]or[-_]path|pretrained[-_]model[-_]name[-_]or[-_]path|base[-_]model|repo[-_]id|checkpoint)$/;
var providerPrefix = /^(?:openai|anthropic|gemini|azure|azure_ai|bedrock|vertex_ai|groq|together_ai|openrouter|cohere|replicate|fireworks_ai|perplexity|xai|mistral|deepseek|ollama|ollama_chat|huggingface)\//;
var hostedProvider = /^(?:openai|anthropic|gemini|google|azure|bedrock|vertex\w*|groq|together\w*|openrouter|cohere|replicate|fireworks\w*|perplexity|xai|mistral|deepseek|deepinfra|nebius|novita|sambanova|cerebras|hf[-_]inference|huggingface[-_]inference|https?:\/\/(?!localhost|127\.|0\.0\.0\.0)\S+)$/;
function hubModelArg(seg) {
  const hosted2 = seg.lower.some((a, j) => {
    const eq = /^--?(?:provider|backend|api[-_]?base|base[-_]?url|api[-_]?url|endpoint)(?:=(.+))?$/.exec(
      a
    );
    return eq !== null && hostedProvider.test(eq[1] ?? seg.lower[j + 1] ?? "");
  });
  if (hosted2) return null;
  for (let j = 1; j < seg.argv.length; j++) {
    const a = seg.lower[j];
    const eq = /^(--?[\w-]+)=(.+)$/.exec(a);
    const flag = eq ? eq[1] : a;
    if (!modelFlag.test(flag)) continue;
    const raw = eq ? seg.argv[j].split("=").slice(1).join("=") : seg.argv[j + 1];
    if (raw && /^[\w.-]+\/[\w.-]+$/.test(raw) && !raw.startsWith(".") && !providerPrefix.test(raw.toLowerCase()) && !/\.(?:gguf|bin|safetensors|pt|pth|onnx|ckpt|json|ya?ml)$/i.test(raw)) {
      return raw;
    }
  }
  return null;
}
function scriptOf(seg) {
  const h = seg.head;
  const prog = seg.argv[0] ?? "";
  if (/^(?:python[\d.]*|py|node|deno|bun|ruby|perl|php|bash|sh|zsh|tsx|ts-node)$/.test(h)) {
    const runIdx = h === "deno" || h === "bun" ? seg.lower[1] === "run" ? 2 : 1 : 1;
    const a = seg.argv.slice(runIdx).find((x) => !x.startsWith("-"));
    return a ?? null;
  }
  if (/^\.\.?\/|^\//.test(prog) || /\.(?:sh|py|exe|bat|cmd|ps1|appimage|run|bin)$/i.test(prog))
    return prog;
  return null;
}
function argNumber(seg, names) {
  for (let j = 0; j < seg.lower.length; j++) {
    const a = seg.lower[j];
    const eq = /^-{0,2}([\w-]+)=(\d+)$/.exec(a);
    if (eq && names.test(eq[1])) return Number(eq[2]);
    if (/^--?[\w-]+$/.test(a) && names.test(a.replace(/^-+/, "")) && /^\d+$/.test(seg.lower[j + 1] ?? "")) {
      return Number(seg.lower[j + 1]);
    }
  }
  return null;
}
var aiModule = /^(?:mlx_lm|mlx_vlm|mlx_whisper|piper|kokoro|whisper|whisperx|faster_whisper|tts|f5_tts|bark|axolotl|llama_cpp|vllm|sglang|audiocraft|demucs|comfy|fooocus|invokeai|torch\.distributed|deepspeed|unsloth)(?:\.|$)/;
var aiAppScript = /(?<![a-z])(?:txt2img|img2img|txt2vid|img2vid|facefusion|sadtalker|wav2lip|liveportrait|animatediff|sample video|infer rvc|rvc infer|gpt sovits|so vits|tortoise tts|deep live cam|roop|run swap)(?![a-z])/;
function aiRuns(seg, st) {
  const h = seg.head;
  const l = seg.lower;
  const script = (scriptOf(seg) ?? "").toLowerCase();
  if (/^(?:whisper|whisperx|faster-whisper|whisper-ctranslate2|insanely-fast-whisper|whisper-cli)$/.test(
    h
  )) {
    const media = l.filter((a) => /\.(?:mp3|wav|m4a|mp4|mkv|flac|ogg|webm|opus|mov)$/.test(a));
    if (media.length === 0) return;
    let w = 3;
    if (l.some((a) => /(?:^|[/_-])(?:large|medium|turbo)/.test(a))) w += 1;
    if (media.length > 1 || media.some((a) => a.includes("*"))) w += 1;
    add(st, hit("speech_model_run", "local_ai_model", w, evidence(seg, 3), h));
    return;
  }
  if (h === "tts" && l.some((a) => /^--(?:text|model_name|list_models)/.test(a))) {
    const model = l[l.indexOf("--model_name") + 1] ?? "";
    add(
      st,
      hit(
        "tts_model_run",
        "local_ai_model",
        /xtts|bark|tortoise/.test(model) ? 4 : 3,
        "tts --text",
        model.split("/").pop() || "Coqui TTS"
      )
    );
    return;
  }
  if (h === "accelerate" && l[1] === "launch" || h === "torchrun" || h === "deepspeed") {
    const target = seg.argv.find((a, j) => j > 0 && /\.py$/.test(a)) ?? h;
    add(st, hit("training_launch", "local_ai_model", 4, evidence(seg, 3), target));
    return;
  }
  if (h === "yolo" && /^(?:train|detect|predict|val)$/.test(l[1] ?? "")) {
    const ep = argNumber(seg, /^epochs$/) ?? 0;
    add(
      st,
      hit(
        "vision_model_run",
        ep >= 20 ? "heavy_compute" : "local_ai_model",
        l[1] === "train" ? 4 : 3,
        evidence(seg, 2),
        "yolo"
      )
    );
    return;
  }
  if (h === "vllm" && l[1] === "serve" || h === "text-generation-launcher" || /^llama-(?:server|cli|run)$/.test(h) || h === "comfy" && /^(?:install|launch)$/.test(l[1] ?? "")) {
    add(st, hit("model_server", "local_ai_model", 4, evidence(seg, 3), seg.argv[2] ?? h));
    return;
  }
  const module = /^python[\d.]*$/.test(h) && l[1] === "-m" ? l[2] ?? "" : "";
  if (aiModule.test(module)) {
    add(st, hit("ai_module", "local_ai_model", 4, evidence(seg, 3), module));
    return;
  }
  if (h === "tune" && l[1] === "run" || h === "axolotl" && /^(?:train|preprocess|inference)$/.test(l[1] ?? "") || h === "autotrain" && l[1] !== void 0 && l[1] !== "--help" || /^f5-tts_infer-(?:cli|gradio)$/.test(h) || /\.llamafile$/.test(h)) {
    add(st, hit("model_run", "local_ai_model", 4, evidence(seg, 3), h));
    return;
  }
  if (!script) return;
  const name = spaced(script.split("/").pop() ?? script);
  if (aiAppScript.test(name)) {
    add(st, hit("ai_script", "local_ai_model", 4, evidence(seg, 2), script));
    return;
  }
  const webui = /(?<![a-z])webui(?![a-z])/.test(name);
  const launcher = /(?<![a-z])(?:launch|entry with update)(?![a-z])/.test(name);
  if ((webui || launcher) && /\.(?:py|sh|bat)$/.test(script)) {
    const gpuFlags = l.some(
      (a) => /^--(?:xformers|medvram|lowvram|no-half\S*|opt-sdp-attention|precision)$/.test(a)
    );
    const w = (webui ? 4 : 3) + (gpuFlags ? 1 : 0);
    add(st, hit("ai_webui", "local_ai_model", w, evidence(seg, 2), script));
    return;
  }
  if (/(?<![a-z])generate(?![a-z])/.test(name) && l.some((a, j) => a === "--task" && /^(?:t2v|i2v|ti2v|s2v|t2i)/.test(l[j + 1] ?? ""))) {
    add(st, hit("video_model_run", "local_ai_model", 4, evidence(seg, 4), script));
    return;
  }
  if (/(?<![a-z])(?:train|finetune|fine tune|dreambooth)/.test(name)) {
    const epochs2 = argNumber(seg, /^(?:epochs?|num[-_]train[-_]epochs|n[-_]epochs)$/) ?? 0;
    const steps = argNumber(seg, /^(?:max[-_]train[-_]steps|max[-_]steps|steps|iters|iterations)$/) ?? 0;
    if (/dreambooth|lora|sdxl|text to image|network/.test(name)) {
      add(st, hit("diffusion_training", "local_ai_model", 4, evidence(seg, 2), script));
    } else if (epochs2 >= 20 || steps >= 1e3) {
      add(
        st,
        hit(
          "long_training",
          "heavy_compute",
          4,
          `${script} ${epochs2 >= 20 ? `${epochs2} epochs` : `${steps} steps`}`,
          script
        )
      );
    }
  }
}
function containers(seg, st) {
  const h = seg.head;
  const l = seg.lower;
  if (h === "nvidia-docker") {
    add(st, hit("gpu_container", "environment", 4, "nvidia-docker"));
    return;
  }
  if (!(["docker", "podman", "nerdctl"].includes(h) && (l[1] === "run" || l[1] === "create")))
    return;
  const image = seg.argv.slice(2).filter(
    (a, j, arr) => !a.startsWith("-") && !/^-[pveiw]$|^--(?:name|env|volume|publish|workdir|network|platform|gpus|runtime|entrypoint|user|mount)$/.test(
      arr[j - 1] ?? ""
    )
  ).shift() ?? "";
  const joined = l.join(" ");
  if (/--gpus(?:[= ]|$)|--runtime[= ]nvidia|--device[= ]nvidia/.test(joined)) {
    add(st, hit("gpu_container", "environment", 4, "docker run --gpus", image || void 0));
    if (image && find(aiName, spaced(image.toLowerCase()))) {
      add(st, hit("ai_image", "local_ai_model", 1, image));
    }
  }
  let risky = 0;
  if (l.includes("--privileged")) risky += 4;
  if (l.some(
    (a, j) => (l[j - 1] === "-v" || l[j - 1] === "--volume") && /^\/(?::|$)|^\/var\/run\/docker\.sock/.test(a)
  ) || /-v[= ]\/:\//.test(joined)) {
    risky += 3;
  }
  if (/--pid[= ]host|--cap-add[= ](?:sys_admin|all)/.test(joined)) risky += 2;
  if (risky > 0) {
    add(
      st,
      hit(
        "host_access_container",
        "untrusted_code",
        Math.min(risky, 5),
        "docker run with host access",
        image || void 0
      )
    );
  }
  if (st.ctx.os === "macos" && /--platform[= ]linux\/amd64/.test(joined)) {
    add(st, hit("x86_emulation", "environment", 2, "--platform linux/amd64"));
  }
}
function drivers(seg, st) {
  const h = seg.head;
  const l = seg.lower;
  if (h === "ubuntu-drivers" && /^(?:autoinstall|install)$/.test(l[1] ?? "")) {
    add(st, hit("gpu_driver_install", "environment", 5, "ubuntu-drivers"));
  } else if (/^(?:cuda_[\w.-]+|nvidia-linux-[\w.-]+)\.run$/.test(h) || (h === "sh" || h === "bash") && /cuda_[\w.-]+\.run|nvidia-linux-[\w.-]+\.run/.test(l[1] ?? "")) {
    add(st, hit("gpu_driver_install", "environment", 5, evidence(seg, 2)));
  } else if (["modprobe", "insmod", "rmmod", "kextload", "kmutil"].includes(h) || h === "dkms" && /^(?:install|add|build)$/.test(l[1] ?? "")) {
    add(st, hit("kernel_module", "environment", 4, evidence(seg, 2), l[1]));
  } else if (["conda", "mamba"].includes(h) && l[1] === "install" && l.some((a) => /^(?:cudatoolkit|cuda|cuda-toolkit|pytorch-cuda)(?:=|$)/.test(a))) {
    add(st, hit("cuda_toolkit_install", "environment", 3, "conda install cuda"));
  }
}
function kernel(seg, st) {
  const h = seg.head;
  const l = seg.lower;
  const joined = l.join(" ");
  if ([
    "grubby",
    "update-grub",
    "grub-mkconfig",
    "grub2-mkconfig",
    "grub-install",
    "efibootmgr",
    "bcdedit",
    "kernelstub"
  ].includes(h)) {
    add(st, hit("boot_config", "risky_experiment", 5, evidence(seg, 3), h));
  } else if (h === "sysctl" && (l.includes("-w") || l.some((a) => /^[\w.]+=\S+$/.test(a)))) {
    add(st, hit("kernel_tuning", "risky_experiment", 3, evidence(seg, 3)));
  } else if (h === "csrutil" && l[1] === "disable") {
    add(st, hit("sip_disable", "risky_experiment", 5, "csrutil disable"));
  }
  if (/mitigations=off/.test(joined))
    add(st, hit("mitigations_off", "risky_experiment", 1, "mitigations=off"));
  const targets = [
    ...seg.redirects,
    ...h === "tee" ? seg.argv.slice(1).filter((a) => !a.startsWith("-")) : []
  ];
  const persisted = targets.find((t) => /^\/etc\/(?:sysctl|default\/grub|modprobe)/.test(t));
  const runtime = targets.find((t) => /^\/(?:proc\/sys|sys)\//.test(t));
  if (persisted || runtime) {
    add(
      st,
      hit(
        "kernel_tuning",
        "risky_experiment",
        persisted ? 4 : 3,
        `> ${persisted ?? runtime}`
      )
    );
  }
  if (l.some(
    (a) => a.includes("/lib/modules/") || a === "modules_install" || a.startsWith("m=$(pwd")
  )) {
    add(st, hit("kernel_module", "environment", 4, evidence(seg, 3)));
  }
}
var systemPath = /^(?:\/|\/\*|~|~\/|~\/\*|\$home|\$\{home\}|\/usr|\/etc|\/bin|\/sbin|\/var|\/boot|\/lib|\/lib64|\/opt|\/system|\/users|\/home|c:\\?)\/?$/;
function destructive2(seg, st) {
  const h = seg.head;
  const l = seg.lower;
  const device = (a) => /^\/dev\/(?!null|zero|random|urandom|stdout|stderr|tty|fd)/.test(a);
  if (h === "dd" && l.some((a) => a.startsWith("of=") && device(a.slice(3)))) {
    add(
      st,
      hit(
        "disk_write",
        "risky_experiment",
        5,
        evidence(seg, 4),
        l.find((a) => a.startsWith("of="))?.slice(3)
      )
    );
  } else if (/^mkfs/.test(h) || h === "wipefs" || ["fdisk", "sfdisk", "gdisk", "sgdisk", "parted"].includes(h) && !l.includes("-l") && l.some(device)) {
    add(st, hit("disk_format", "risky_experiment", 5, evidence(seg, 3)));
  } else if (h === "shred" && l.some(device)) {
    add(st, hit("disk_wipe", "risky_experiment", 5, evidence(seg, 3)));
  } else if (h === "diskutil" && /^(?:erasedisk|erasevolume|zerodisk|secureerase|partitiondisk|reformat)$/.test(l[1] ?? "")) {
    add(st, hit("disk_format", "risky_experiment", 5, evidence(seg, 3)));
  } else if (h === "rm" && l.some((a) => /^-[a-z]*r/.test(a) || a === "--recursive") && l.slice(1).some((a) => !a.startsWith("-") && systemPath.test(a))) {
    add(st, hit("delete_system", "risky_experiment", 5, evidence(seg, 4)));
  } else if ((h === "chmod" || h === "chown") && l.includes("-r") && l.some((a) => a === "/" || a === "/usr" || a === "/etc")) {
    add(st, hit("system_permissions", "risky_experiment", 4, evidence(seg, 4)));
  } else if (h === "kill" && l.includes("-9") && l.includes("-1")) {
    add(st, hit("kill_all", "risky_experiment", 4, "kill -9 -1"));
  } else if (h === "format" && /^[c-z]:$/.test(l[1] ?? "")) {
    add(st, hit("disk_format", "risky_experiment", 5, evidence(seg, 2)));
  }
  if (seg.redirects.some((t) => /^\/dev\/(?:sd[a-z]|nvme\d|disk\d|hd[a-z]|mmcblk\d)/.test(t))) {
    add(st, hit("disk_write", "risky_experiment", 5, `> ${seg.redirects[0]}`));
  }
  if (seg.redirects.some((t) => t === "/proc/sysrq-trigger")) {
    add(st, hit("kernel_crash", "risky_experiment", 5, "> /proc/sysrq-trigger"));
  }
}
function duration(v) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(v);
  if (!m) return 0;
  const n = Number(m[1]);
  return n * ({ ms: 1e-3, s: 1, m: 60, h: 3600, d: 86400 }[m[2] ?? "s"] ?? 1);
}
function load(seg, st) {
  const h = seg.head;
  const l = seg.lower;
  if (["stress", "stress-ng", "memtester", "s-tui", "y-cruncher", "prime95", "mprime"].includes(h)) {
    const at = l.findIndex((a) => /^(?:-t|--timeout)(?:=|$)/.test(a));
    const limit = at === -1 ? "" : l[at]?.split("=")[1] ?? l[at + 1] ?? "";
    const secs2 = duration(limit);
    add(
      st,
      hit(
        "stress_tool",
        "heavy_compute",
        secs2 > 0 && secs2 <= 120 ? 2 : 4,
        evidence(seg, 3),
        h
      )
    );
    return;
  }
  if (h === "sysbench") {
    add(st, hit("stress_tool", "heavy_compute", 3, evidence(seg, 3), h));
    return;
  }
  const tools = [
    "wrk",
    "wrk2",
    "ab",
    "hey",
    "oha",
    "bombardier",
    "vegeta",
    "siege",
    "k6",
    "locust",
    "artillery",
    "jmeter",
    "autocannon",
    "loadtest",
    "drill",
    "gatling"
  ];
  if (!tools.includes(h)) return;
  const target = seg.argv.find((a) => /^https?:\/\//i.test(a));
  if (target && isLocal(target)) return;
  let w = 3;
  let secs = 0;
  for (let j = 1; j < l.length; j++) {
    const a = l[j];
    const flag = /^(?:-d|--duration|-t|--time|-z|--run-time|-duration)$/.test(a) ? l[j + 1] : /^(?:-d|--?duration=|-z|--run-time=)(\d.*)$/.exec(a)?.[1];
    if (flag) secs = Math.max(secs, duration(flag));
  }
  const conns = argNumber(seg, /^(?:c|connections|concurrency|u|users|vus|rate)$/) ?? 0;
  if (secs >= 300) w += 1;
  if (conns >= 500) w += 1;
  add(
    st,
    hit(
      "load_test",
      "heavy_compute",
      w,
      evidence(seg, 4),
      target ? hostPath(target).split("/")[0] : h
    )
  );
}
function longJobs(seg, segs, st) {
  const h = seg.head;
  const l = seg.lower;
  const joined = l.join(" ");
  if (h === "bazel" && l[1] === "build" && /\/\/\.\.\./.test(joined)) {
    add(st, hit("long_build", "heavy_compute", 3, "bazel build //..."));
  } else if (h === "autoninja") {
    add(st, hit("long_build", "heavy_compute", 4, evidence(seg, 3), "autoninja"));
  } else if (h === "docker" && l[1] === "buildx" && /--platform[= ]\S+,\S+/.test(joined)) {
    add(st, hit("long_build", "heavy_compute", 2, "docker buildx multi-platform"));
  } else if (h === "ffmpeg" && /libx265|libaom|libsvtav1|-preset (?:slow|slower|veryslow)/.test(joined)) {
    const loop = segs.some((s) => s.head === "for" || s.head === "while");
    const slowest = /-preset (?:veryslow|placebo)|-cpu-used [01]\b/.test(joined);
    add(st, hit("video_encode", "heavy_compute", loop || slowest ? 4 : 3, evidence(seg, 3)));
  } else if (h === "blender" && (l.includes("-b") || l.includes("--background"))) {
    const animation = l.includes("-a") || l.includes("--render-anim");
    add(st, hit("render", "heavy_compute", animation ? 4 : 3, "blender -b"));
  } else if (h === "gmx" && l[1] === "mdrun" || h === "hashcat" || h === "john") {
    add(st, hit("long_compute", "heavy_compute", 3, evidence(seg, 2), h));
  } else if (/^python[\d.]*$/.test(h)) {
    const epochs2 = argNumber(seg, /^(?:epochs?|num[-_]train[-_]epochs|n[-_]epochs)$/) ?? 0;
    if (epochs2 >= 20 && !st.hits.some((x) => x.id === "long_training")) {
      add(
        st,
        hit(
          "long_training",
          "heavy_compute",
          4,
          `--epochs ${epochs2}`,
          scriptOf(seg) ?? void 0
        )
      );
    }
  }
}
var lureName = /(?<![a-z])(?:drainer|aimbot|wallhack|cracked|keygen|stealer|activator|spoofer|nitro gen|token grab\w*|seed finder|wallet recover\w*)(?![a-z])/;
var pocName = /(?<![a-z])(?:exploit|exploits|sploit|cve \d{4} \d+|lpe|privesc|rce|0day|pwn|rootkit)(?![a-z])/;
var lureWeak = /^(?:airdrop|cheat|cheats|injector|crack|grabber|sniper|mev|unlocker)$/;
var pocWeak2 = /^(?:poc|pocs)$/;
var lureCompanion = /^(?:roblox|valorant|fortnite|cs2|csgo|apex|warzone|gta|pubg|tarkov|overwatch|r6|dota|genshin|minecraft|rust|cod|league|lol|steam|discord|token|tokens|nitro|wallet|wallets|dll|nft|sol|solana|eth|crypto|coin|pump|memecoin|account|accounts|password|passwords|cookie|cookies|claim|claimer|game|games|esp|aim|bot|tool|tools|loader|launcher|main|run|start|script|app|free|pro|new|final|latest|setup|install|x64|x86|win|win64|cli|gui|auto|v?\d+|py|js|mjs|cjs|ts|sh|bat|cmd|ps1|exe|rb|pl|php|c|cpp)$/;
function namedLike(name, strong, weak, other) {
  if (strong.test(name)) return true;
  const words2 = name.split(" ").filter(Boolean);
  if (!words2.some((w) => weak.test(w))) return false;
  return words2.every((w) => weak.test(w) || lureCompanion.test(w) || other.test(w));
}
var isLureName = (name) => namedLike(name, lureName, lureWeak, lureName);
var isPocName = (name) => namedLike(name, pocName, pocWeak2, pocName);
var walletSecret = /\.config\/solana\/[\w.-]+\.json|(?:^|\/)(?:keystore|keypairs?)(?:\/|\.json|$)|wallet\.dat|\.(?:ethereum|bitcoin|electrum)\/|^--(?:private[-_]?key|mnemonic|seed(?:[-_]phrase)?|keypair|wallet(?:[-_]?(?:file|path|key))?)(?:=|$)/;
var disguised = /\.(?:pdf|docx?|xlsx?|jpe?g|png|mp4|mp3|txt)\.(?:exe|scr|bat|cmd|js|vbs|lnk|com|pif|app)$/i;
function disguisedFile2(seg, st) {
  const fake = seg.argv.find((a) => disguised.test(a));
  if (fake) add(st, hit("disguised_file", "untrusted_code", 5, fake, fake));
}
function lures(seg, st) {
  const script = scriptOf(seg);
  const h = seg.head;
  if (script) {
    const name = spaced((script.split(/[\\/]/).pop() ?? script).toLowerCase());
    if (isLureName(name))
      add(st, hit("lure_script", "untrusted_code", 4, evidence(seg, 2), script));
    else if (isPocName(name))
      add(st, hit("exploit_run", "untrusted_code", 5, evidence(seg, 2), script));
    if (/\.(?:exe|msi|bat|scr|cmd)$/i.test(script) && !/^(?:python|node)/.test(h)) {
      add(st, hit("windows_binary", "untrusted_code", 3, script, script));
    }
  }
  if (["gcc", "g++", "cc", "clang", "clang++", "tcc"].includes(h)) {
    const files = seg.lower.slice(1).filter((a) => !a.startsWith("-"));
    const named2 = files.find((a) => isPocName(spaced(a.split("/").pop() ?? a)));
    if (named2) add(st, hit("exploit_build", "untrusted_code", 4, evidence(seg, 4), named2));
  }
  if (h === "wine" && /\.(?:exe|msi)$/i.test(seg.argv[1] ?? "")) {
    add(st, hit("windows_binary", "untrusted_code", 3, evidence(seg, 2), seg.argv[1]));
  }
  if (seg.lower.slice(1).some((a) => walletSecret.test(a))) {
    add(st, hit("wallet_secret", "untrusted_code", 2, "wallet key passed to a script"));
  }
}
function quarantine(seg, st) {
  const h = seg.head;
  const l = seg.lower;
  const joined = l.join(" ");
  if (h === "xattr" && (l.includes("com.apple.quarantine") || l.some((a) => /^-[a-z]*[cd][a-z]*$/.test(a)))) {
    add(
      st,
      hit(
        "quarantine_removal",
        "untrusted_code",
        5,
        evidence(seg, 3),
        seg.argv[seg.argv.length - 1]
      )
    );
  } else if (h === "spctl" && /--master-disable|--global-disable|--add/.test(joined)) {
    add(st, hit("gatekeeper_off", "untrusted_code", 5, evidence(seg, 2)));
  } else if (/^(?:set|add)-mppreference$/.test(h) && /-disable|-exclusion/.test(joined)) {
    add(st, hit("defender_off", "untrusted_code", 5, evidence(seg, 2)));
  } else if ((h === "7z" || h === "7za") && l[1] === "x" && l.some((a) => /^-p\S/.test(a))) {
    add(st, hit("password_archive", "untrusted_code", 4, "7z x -p"));
  } else if (h === "unzip" && l.includes("-p") || h === "unrar" && l.some((a) => /^-p\S/.test(a))) {
    add(st, hit("password_archive", "untrusted_code", 4, `${h} with a password`));
  }
}
function downloadCradle(raw) {
  for (const line of raw.split("\n")) {
    if (!/\b(?:iex|invoke-expression)\b|\[scriptblock\]::create/i.test(line)) continue;
    if (!/downloadstring|\b(?:iwr|irm)\b|invoke-webrequest|invoke-restmethod/i.test(line))
      continue;
    const url = /https?:\/\/[^\s'")]+/i.exec(line);
    if (url) return url[0];
  }
  return null;
}
var abuseHeads = /* @__PURE__ */ new Set([
  "xmrig",
  "cpuminer",
  "minerd",
  "nbminer",
  "t-rex",
  "lolminer",
  "phoenixminer",
  "ethminer",
  "xmr-stak",
  "srbminer",
  "masscan",
  "zmap",
  "slowloris",
  "loic",
  "hoic",
  "thc-ssl-dos"
]);
var scanHeads = /* @__PURE__ */ new Set([
  "nmap",
  "arp-scan",
  "netdiscover",
  "rustscan",
  "fping",
  "angryip",
  "nbtscan"
]);
function policy(segs, text) {
  for (const seg of segs) {
    if (abuseHeads.has(seg.head)) return hit("abuse", null, -10, seg.head);
    if (seg.head === "hping3" && seg.lower.some((a) => a === "--flood" || /^-i$|^u\d+$/.test(a))) {
      return hit("abuse", null, -10, "hping3 --flood");
    }
    if (["hydra", "medusa", "ncrack", "patator"].includes(seg.head) && seg.lower.some((a) => /^-[pPlLC]$/.test(a))) {
      return hit("abuse", null, -10, `${seg.head} password guessing`);
    }
    if (scanHeads.has(seg.head)) {
      const targets = seg.lower.slice(1).filter((a) => !a.startsWith("-"));
      if (targets.some((t) => /^0\.0\.0\.0\/0$|\/(?:[0-9]|1[0-5])$/.test(t))) {
        return hit("abuse", null, -10, `${seg.head} of a wide range`);
      }
      if (targets.length === 0 || targets.some(
        (t) => privateTarget.test(t) || /^(?:192\.168|10|172\.(?:1[6-9]|2\d|3[01]))\./.test(t)
      )) {
        return hit("lan_scan", null, -10, `${seg.head} of a local network`);
      }
    }
  }
  const m = text === null ? null : find(abuse, text);
  return m ? hit("abuse", null, -10, m[0]) : null;
}
function classifyCommand(command, ctx = {}) {
  const raw = ascii(clip(command)).trim();
  if (raw === "") return none;
  const segs = withWritten(parse(raw));
  const st = {
    ctx,
    hits: [],
    cloned: false,
    clonedRepo: null,
    clonedFamous: false,
    ranClonedCode: false,
    downloads: /* @__PURE__ */ new Set()
  };
  const cradle = downloadCradle(raw);
  if (cradle && !isMainstream(cradle)) {
    add(st, hit("pipe_to_shell", "untrusted_code", 6, "iex download", hostPath(cradle)));
  }
  if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(raw)) {
    add(st, hit("fork_bomb", "risky_experiment", 5, ":(){ :|:& };:"));
  }
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    destructive2(seg, st);
    kernel(seg, st);
    disguisedFile2(seg, st);
    if (readOnly2.has(seg.head)) continue;
    remoteExec(segs, i, st);
    decodedExec(segs, i, st);
    inlineCode(seg, st);
    policyBypass(seg, st);
    downloadThenRun(seg, st);
    gitClone(seg, st);
    clonedCode(seg, st);
    packages(seg, st);
    remoteBuild(seg, st);
    models(seg, st);
    aiRuns(seg, st);
    containers(seg, st);
    drivers(seg, st);
    load(seg, st);
    longJobs(seg, segs, st);
    lures(seg, st);
    quarantine(seg, st);
  }
  const sudoInstall = segs.find(
    (s) => s.sudo && (s.head === "make" && s.lower[1] === "install" || /^python[\d.]*$/.test(s.head) && s.lower[1] === "setup.py" && s.lower[2] === "install")
  );
  if (sudoInstall) {
    add(st, hit("system_wide_install", "environment", 4, evidence(sudoInstall, 3)));
  } else if (segs.some((s) => s.sudo && /^\.\/(?:install|setup)[\w-]*\.sh$/.test(s.argv[0] ?? ""))) {
    add(st, hit("sudo_install_script", "environment", 2, "sudo ./install.sh"));
  }
  const stop = policy(segs, st.hits.some((h) => h.weight > 0) ? norm(raw) : null);
  if (stop) return refuse(st.hits, stop);
  const c = finish(st.hits);
  return c.subject ? { ...c, subject: asTyped(c.subject, raw) } : c;
}

// packages/intent/src/failure.ts
var heavyWheel = String.raw`flash[-_]?attn|xformers|bitsandbytes|deepspeed|triton|auto[-_]?gptq|llama[-_]cpp[-_]python|mamba[-_]ssm|causal[-_]conv1d|vllm|apex|tensorrt|pycuda|cupy|dlib|insightface|tts|pyaudio|sentencepiece|tokenizers|torch\w{0,12}|onnxruntime[\w-]{0,12}|exllamav2|detectron2`;
var signatures = [
  {
    id: "cuda_missing",
    category: "environment",
    re: /torch not compiled with cuda enabled|no cuda gpus are available|found no nvidia driver|nvidia-smi: (?:command )?not found|cuda is not available|cuda_home environment variable is not set|no cuda runtime is found|libcuda\.so[^\n]{0,60}(?:no such file|cannot open|not found)|could not load (?:dynamic )?library '?libcud\w*|nvcc: (?:command )?not found|cuda driver version is insufficient|nvidia driver on your system is too old|cuda error: no kernel image|requires (?:an? )?(?:nvidia gpu|cuda)|torch\.cuda\.is_available\(\)[^\n]{0,20}false|no nvidia gpu (?:found|detected)/
  },
  {
    id: "gpu_out_of_memory",
    category: "local_ai_model",
    re: /cuda out of memory|outofmemoryerror: cuda|mps backend out of memory|cublas_status_alloc_failed|cudnn_status_alloc_failed|not enough memory to allocate[^\n]{0,40}(?:gpu|mps|vram)/
  },
  {
    id: "disk_full",
    category: "heavy_compute",
    re: /no space left on device|errno 28|not enough (?:free )?disk space|insufficient (?:free )?(?:disk )?space|disk quota exceeded/
  },
  {
    id: "killed_out_of_memory",
    category: "heavy_compute",
    re: /(?:^|\n)\s*killed(?::\s*9)?\s*(?:\n|$)|\b(?:zsh|bash|sh): (?:line \d+: )?(?:\d+ )?killed\b|\b\d+ killed\s|exit code 137\b|killed by signal 9|signal: killed|\bsigkill\b|\bout of memory\b|cannot allocate memory|memoryerror|oom[- ]?kill\w*|std::bad_alloc|javascript heap out of memory/
  },
  {
    id: "externally_managed",
    category: "environment",
    re: /externally-managed-environment/
  },
  {
    id: "ml_wheel_build",
    category: "environment",
    re: new RegExp(
      String.raw`(?:failed (?:building wheel|to build)|could not build wheels|building wheel for [\w.-]{1,80} \(pyproject\.toml\) did not run successfully|error: subprocess-exited-with-error)[^\n]{0,120}?(?:${heavyWheel})|(?<![\w-])(?:${heavyWheel})[^\n]{0,60}?(?:failed (?:building wheel|to build))|could not find a version that satisfies the requirement (?:torch|torchvision|torchaudio)[^\s]{0,40}\+cu\d+`
    )
  },
  {
    id: "exec_format",
    category: "environment",
    re: /exec format error|bad cpu type in executable|cannot execute binary file|illegal instruction|mach-o, but wrong architecture|incompatible architecture|have 'arm64', need 'x86_64'|have 'x86_64', need 'arm64e?'/
  },
  {
    id: "platform_unsupported",
    category: "environment",
    // npm warns about optional packages for other platforms during ordinary installs
    re: /(?:^|\n)(?!npm warn)[^\n]*?(?:unsupported platform|ebadplatform)|platform (?:is )?not supported|not supported on (?:this platform|darwin|macos|mac os|windows|win32|arm64)|only (?:supported|works|runs|available) on linux|only supports? linux|supports? only linux|linux[- ]only|requires linux|is not a supported wheel on this platform|does not match the detected host platform|(?:apt-get|apt|systemctl|modprobe|dpkg|yum|dnf|lsmod|ldconfig): command not found|is not supported on this (?:os|operating system)/
  },
  {
    id: "docker_daemon",
    category: "environment",
    re: /cannot connect to the docker daemon|is the docker daemon running|docker: command not found|docker daemon is not running|failed to connect to the docker api|error during connect:[^\n]{0,80}docker/
  }
];
function excerpt(error) {
  return norm(
    clip(error.length > 12e3 ? `${error.slice(0, 4e3)}
${error.slice(-8e3)}` : error)
  );
}
function classifyFailure(command, error, _ctx = {}) {
  const text = excerpt(error);
  if (text === "") return none;
  const hits = [];
  const subject = quoteSafe(command.split("\n")[0] ?? "", 50) || "a local command";
  for (const s of signatures) {
    const m = s.re.exec(text);
    if (m) hits.push(hit(s.id, s.category, 6, m[0], subject));
  }
  if (hits.length === 0) return none;
  return finish(hits.slice(0, 1).concat(hits.slice(1).map((h) => ({ ...h, weight: 1 }))));
}

// packages/intent/src/hints.ts
var hintPrefix = "Bugnet hint (local pattern match, nothing was sent anywhere):";
var maxHintChars = 600;
var noun = {
  local_ai_model: "an AI model to run on this computer",
  untrusted_code: "code the user has not vetted",
  environment: "a tool that needs Linux, x86, an NVIDIA GPU or system-wide changes",
  risky_experiment: "a risky system experiment",
  heavy_compute: "a long and heavy job"
};
var signalNoun = {
  heavy_ml_install: "a heavy ML package (PyTorch, CUDA builds, model runtimes)",
  nvidia_only_package: "a package that only works with NVIDIA CUDA",
  ai_runtime_install: "a local AI runtime that downloads models next",
  model_download: "AI model weights",
  model_repo_clone: "AI model weights",
  model_repo: "AI model weights",
  weights_download: "AI model weights",
  model_download_script: "a script that downloads AI model weights",
  lfs_pull: "large files, usually model weights",
  runs_cloned_code: "code from a repository cloned in this session, which the user has not vetted",
  asks_isolation: "code in an isolated machine instead of this computer",
  not_on_my_machine: "code somewhere other than this computer"
};
var signalWhy = {
  asks_isolation: "The user asked for the work to stay off this computer.",
  not_on_my_machine: "The user asked for the work to stay off this computer."
};
var why = {
  local_ai_model: "The local route usually downloads gigabytes of model weights and installs PyTorch and CUDA packages into the user's environment.",
  untrusted_code: "Unvetted code run locally, even from a temporary folder, gets the same access as the user, including their files, SSH keys and credentials.",
  environment: "Locally it means changing the user's own system or fighting a mismatch with its OS, CPU or GPU.",
  risky_experiment: "On the local machine it can wipe data or leave the system unstable.",
  heavy_compute: "On the local machine it keeps the user's computer busy for a long time."
};
var failureWhy = {
  local_ai_model: "The model needs more memory than this machine has.",
  untrusted_code: "The code did not run as expected on this machine.",
  environment: "This machine lacks the OS, CPU, GPU or setup that the command expects.",
  risky_experiment: "The command could not run safely on this machine.",
  heavy_compute: "This machine ran out of memory or disk for the job."
};
var failureCause = {
  cuda_missing: "no usable NVIDIA GPU or CUDA on this machine",
  gpu_out_of_memory: "the GPU running out of memory",
  disk_full: "no disk space left on this machine",
  killed_out_of_memory: "the process being killed or running out of memory",
  externally_managed: "the system Python refusing package installs (externally-managed-environment)",
  ml_wheel_build: "a heavy ML package that would not build here",
  exec_format: "a binary built for another CPU architecture",
  platform_unsupported: "a tool that does not support this operating system",
  docker_daemon: "no running Docker daemon on this machine"
};
var sandbox = "a disposable cloud Linux sandbox through Bugnet's tools in this session, which bugnet_assess checks and prices for free";
var choice = {
  prompt: `The user has not been asked yet where it should run: this computer, or ${sandbox}.`,
  command: `The user has not been asked yet where it should run: this computer, or ${sandbox}.`,
  failure: `The user has not been asked yet whether to retry it here or in ${sandbox}.`
};
var offThisComputer = `The user has not been asked yet whether to use ${sandbox}.`;
var notOffered = "Bugnet has not been offered in this session.";
function lead(c) {
  return c.signals.find((s) => s.weight > 0 && s.category === c.category);
}
function described(c, subjectMax) {
  const category = c.category;
  const top = lead(c);
  const what = (top && signalNoun[top.id]) ?? noun[category];
  const subject = c.subject ? quoteSafe(c.subject, subjectMax) : "";
  if (!subject) return what;
  return `"${subject}", ${what}`;
}
function detection(c, kind, max) {
  if (kind === "failure") {
    const top = lead(c);
    const cause = (top && failureCause[top.id]) ?? "a limit of this machine";
    const command = c.subject ? quoteSafe(c.subject, max) : "a Bash command";
    return `a local command (${command}) just failed with ${cause}.`;
  }
  if (kind === "command") {
    const step = lead(c)?.evidence;
    const shown = step ? ` (${quoteSafe(step, max)})` : "";
    return `a Bash command about to run${shown} involves ${described(c, max)}.`;
  }
  return `the prompt asks to run or set up ${described(c, max)}.`;
}
function hintFor(c, kind) {
  if (!c.suggest || !c.category) return "";
  const top = lead(c);
  const asked = kind !== "failure" && top !== void 0 && top.id in signalWhy;
  const reason = kind === "failure" ? failureWhy[c.category] : (top && signalWhy[top.id]) ?? why[c.category];
  const next = asked ? offThisComputer : choice[kind];
  for (const max of [60, 36, 20]) {
    const text = `${hintPrefix} ${detection(c, kind, max)} ${reason} ${next} ${notOffered}`;
    if (text.length <= maxHintChars) return text;
  }
  return `${hintPrefix} ${reason} ${next} ${notOffered}`;
}

// packages/intent/src/prompt.ts
var clauseBreak = /[.!?;]+(?=\s|$)|\n|,? (?:and )?then |,? after that |,? also |(?<=^|\s)\d[.)](?=\s)|\s[-*](?=\s)/g;
var commandStart = /(?<![\w-])(?:curl|wget|iwr|irm|invoke-webrequest|sudo|git clone|docker run|dd|rm -rf|xattr)\s[^\n]*?(?=[.!?](?:\s|$)|\n|$)|`[^`\n]+`/g;
var pasteLine = /^(?:#{1,6} |[$>] |\+ |-{3,}|={3,}|\||\[?\d{1,4}[-/:.]\d{1,2}|\[(?:info|warn|warning|error|debug|trace|fatal)\]|(?:info|warn|warning|error|err!|debug|trace|fatal|npm err!|npm warn)\b|at [\w$.<]+ ?\(|file "|traceback|step \d|#\d+ |-? ?(?:run|script|command|steps?):)/;
var commandLine = /^(?:sudo |run )?(?:curl|wget|iwr|irm|bash|sh|zsh|git|npm|npx|pnpm|yarn|bun|pip3?|pipx|uv|python3?|node|deno|docker|podman|brew|apt(?:-get)?|dnf|yum|chmod|make|cargo|go|export|source|\.\/)(?![\w-])/;
var requestWords = /\?|\b(?:can you|could you|would you|please|pls|plz|for me|help me|i want|i'd like|i need|is it safe|is this safe|and then|then run|and run)\b/;
var errorLike = /cuda|nvidia|nvcc|libcud|memory|space|errno|quota|killed|kill|137|sigkill|alloc|externally|wheel|requirement|exec format|cpu type|binary file|instruction|architecture|platform|linux|command not found|docker/;
var maxPasted = 8;
var maxWeakNames = 8;
var workItem = /^\/(?:pull|pulls|issues|commit|commits|compare|actions|discussions|wiki|milestones?|projects|security|-\/(?:merge_requests|issues|commit|pipelines|jobs))(?![\w-])/;
var assetArchive = /(?:^|[\s_.-])(?:icons?|images?|imgs?|assets?|fonts?|photos?|pics?|logos?|designs?|mockups?|sprites?|screenshots?|textures?|sounds?|audio|music|videos?|data|datasets?|exports?|backups?|csv|docs?|reports?|slides?|invoices?|figma|brand\w*)(?:[\s_.-]\w+)*\.(?:zip|rar|7z|tar\.gz|tgz)$/;
function clauseStarts(t) {
  const starts = [0];
  for (const m of findAll(clauseBreak, t)) starts.push(m.index + m[0].length);
  return starts;
}
function clauseOf(starts, at) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = lo + hi + 1 >> 1;
    if (starts[mid] <= at) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
function blank(t, spans2) {
  const ranges = [...spans2].sort((a, b) => a[0] - b[0]);
  const parts = [];
  let at = 0;
  for (const [from, to] of ranges) {
    if (to <= at) continue;
    const start = Math.max(from, at);
    parts.push(t.slice(at, start), " ".repeat(to - start));
    at = to;
  }
  parts.push(t.slice(at));
  return parts.join("");
}
function spans(matches) {
  return matches.map((m) => [m.index, m.index + m[0].length]);
}
function pastedLines(t) {
  if (!t.includes("\n")) return [];
  const out = [];
  let fence = false;
  let at = 0;
  for (const line of t.split("\n")) {
    const end = at + line.length;
    const marker = /^(?:```|~~~)/.test(line);
    const command = commandLine.test(line) && !requestWords.test(line);
    if (marker || fence || pasteLine.test(line) || command) out.push([at, end]);
    if (marker) fence = !fence;
    at = end + 1;
  }
  return out;
}
function named(t, m) {
  if (!m) return null;
  let at = m.index;
  while (at > 0 && /[\w-]/.test(t[at - 1])) at--;
  const out = [t.slice(at, m.index + m[0].length)];
  out.index = at;
  return out;
}
function before(t, at, chars = 40) {
  return t.slice(Math.max(0, at - chars), at);
}
function repoShort(url) {
  return url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/^git@([^:]+):/, "$1/").replace(/\.git$/, "").split("/").slice(0, 3).join("/");
}
function classifyPrompt(text, ctx = {}) {
  const full = norm(text);
  if (full === "") return none;
  const pasted = pastedLines(full);
  const request = pasted.length > 0 ? blank(full, pasted) : full;
  const keepPaste = pasted.length === 0 || !/[a-z]/.test(request) || find(runsPasted, request) !== null;
  const t = keepPaste ? full : request;
  const repos = findAll(repoUrl, t);
  const hfs = findAll(hfUrl, t);
  const urls = findAll(anyUrl, t);
  const bare = blank(t, spans([...urls, ...repos, ...hfs]));
  const act = find(action, bare);
  const verb = find(taskVerb, bare);
  const doing = act !== null || verb !== null;
  const isLocal2 = find(local, bare) !== null;
  const mac = ctx.os === "macos" || ctx.os !== "windows" && find(macText, bare) !== null;
  const win = !mac && (ctx.os === "windows" || !ctx.os && find(windowsText, bare) !== null);
  const notLinux = mac || win;
  const starts = clauseStarts(t);
  const located = [];
  const global = [];
  const put = (at, h) => located.push({ at, hit: h });
  const near = (m) => {
    const end = m.index + m[0].length;
    const pre = /(?:\S+\s+){0,5}$/.exec(bare.slice(Math.max(0, m.index - 120), m.index));
    const post2 = /^(?:\s+\S+){0,5}/.exec(bare.slice(end, end + 120));
    const around = `${pre?.[0] ?? ""}${m[0]}${post2?.[0] ?? ""}`;
    return [aiContext, aiTask, taskVerb].some((re) => find(re, around) !== null);
  };
  const weak = findAll(aiWeakName, t).slice(0, maxWeakNames).filter(near);
  const names = [...findAll(aiName, t), ...weak].filter(
    (m) => !integrationAfter.test(t.slice(m.index + m[0].length, m.index + m[0].length + 40))
  );
  names.sort((a, b) => a.index - b.index);
  const tasks = findAll(aiTask, bare);
  const assistant = find(localAssistant, bare);
  const strong = [
    find(voiceClone, bare),
    assistant && (isLocal2 || /^(?:local|offline|self)/.test(assistant[0])) ? assistant : null
  ].find((m) => m && !createBefore.test(before(bare, m.index, 30)));
  const ai = names[0] ?? strong ?? tasks[0];
  if (ai) {
    const named2 = names.length > 0;
    const task = strong ? doing ? 4 : isLocal2 ? 3 : 0 : doing ? 3 : 0;
    const w = named2 ? doing ? 4 : isLocal2 ? 3 : 1 : task;
    const at = ai.index;
    const subject = named2 || !strong ? ai[0] : void 0;
    if (w > 0) {
      put(at, hit(named2 ? "ai_model" : "ai_task", "local_ai_model", w, ai[0], subject));
    }
    if (w >= 3) {
      if (isLocal2 && doing) put(at, hit("runs_locally", "local_ai_model", 1, "locally"));
      const big = findAll(paramSize, t).find((m) => Number(m[1]) >= 13);
      if (big) put(at, hit("large_model", "local_ai_model", 2, big[0]));
      const video = find(videoName, t);
      if (video) put(at, hit("video_model", "local_ai_model", 1, video[0]));
      const weights = find(weightsCue, bare);
      if (weights) put(at, hit("model_weights", "local_ai_model", 1, weights[0]));
    }
  }
  let externalRepo = false;
  for (const m of repos) {
    const at = m.index;
    if (find(ownRepoBefore, before(t, at)) || isFamousRepo(repoShort(m[0]))) continue;
    if (workItem.test(t.slice(at + m[0].length, at + m[0].length + 20))) continue;
    externalRepo = true;
    put(at, hit("unfamiliar_repo", "untrusted_code", act ? 4 : 1, m[0], repoShort(m[0])));
    break;
  }
  const hf = hfs.find((m) => !/\/datasets\//.test(m[0]));
  if (hf && act) {
    put(hf.index, hit("model_repo", "local_ai_model", 4, hf[0], repoShort(hf[0])));
  }
  const script = findAll(scriptUrl, t)[0];
  if (script && act && !externalRepo) {
    put(script.index, hit("script_url", "untrusted_code", 4, script[0], script[0]));
  }
  const file = named(bare, find(receivedFile, bare));
  const fileContext = find(receivedContext, bare);
  const from = find(origin, bare);
  if (from) put(from.index, hit("origin", "untrusted_code", doing ? 4 : 3, from[0]));
  const strongFile = named(bare, find(disguisedFile, bare)) ?? find(enableMacros, bare);
  if (strongFile) {
    put(
      strongFile.index,
      hit("disguised_file", "untrusted_code", 4, strongFile[0], strongFile[0])
    );
  } else if (file) {
    const assets = assetArchive.test(file[0]);
    const w = act && !assets ? fileContext || from ? 4 : 2 : 1;
    put(file.index, hit("received_file", "untrusted_code", w, file[0], file[0]));
  }
  const post = file || strongFile ? null : find(mailed, bare);
  if (post && act) {
    const around = bare.slice(Math.max(0, post.index - 50), post.index + post[0].length + 50);
    if (find(codeKind, around))
      put(post.index, hit("received_file", "untrusted_code", 4, post[0]));
  }
  const av = find(avOff, bare);
  if (av) put(av.index, hit("security_bypass", "untrusted_code", 4, av[0]));
  for (const m of findAll(lure, t)) {
    const at = m.index;
    const pre = before(t, at, 30);
    if (ownBefore.test(pre) || createBefore.test(pre)) continue;
    put(at, hit("lure", "untrusted_code", doing ? 4 : 2, m[0], m[0]));
    break;
  }
  const flawed = find(flaw, bare);
  const exploit = find(poc, bare) ?? findAll(pocWeak, bare).slice(0, maxWeakNames).find((m) => {
    const around = bare.slice(Math.max(0, m.index - 40), m.index + m[0].length + 60);
    return find(flaw, around) !== null || find(poc, around) !== null;
  });
  if (exploit && act) {
    const used = flawed !== null || find(exploitUse, bare) !== null;
    put(
      exploit.index,
      hit("exploit", "untrusted_code", used ? 4 : 2, exploit[0], exploit[0])
    );
  }
  const unvetted = () => located.some((l) => l.hit.category === "untrusted_code" && l.hit.weight >= 3);
  const secret = find(wantsSecrets, bare);
  if (secret && unvetted())
    put(secret.index, hit("wants_secrets", "untrusted_code", 2, secret[0]));
  const doubt = find(safety, bare);
  const about = urls.length > 0 || repos.length > 0 || file !== null || from !== null || find(repoWord, bare) !== null;
  if (doubt) global.push(hit("safety_doubt", "untrusted_code", about ? 3 : 1, doubt[0]));
  const iso = find(explicit, bare);
  if (iso) {
    const around = bare.slice(Math.max(0, iso.index - 40), iso.index + iso[0].length + 60);
    if (!find(notIsolation, around)) global.push(hit("asks_isolation", null, 6, iso[0]));
  }
  const away = find(notMine, bare);
  if (away) global.push(hit("not_on_my_machine", null, 4, away[0]));
  const nv = mac ? find(nvidiaOnly, bare) : null;
  const cpu = /\bcpu[- ](?:fallback|only)\b|\bon (?:the )?cpu\b/.test(bare);
  const need = mac && !cpu ? find(nvidiaNeed, bare) : null;
  const gap = find(hardwareGap, bare);
  if (mac && (need || nv && gap)) {
    const m = need ?? nv;
    put(m.index, hit("needs_nvidia", "environment", act ? 4 : 3, m[0]));
  } else if (mac && nv) {
    put(nv.index, hit("mentions_nvidia", "environment", 2, nv[0]));
  }
  if (gap && (nv || ai || act)) put(gap.index, hit("hardware_gap", "environment", 2, gap[0]));
  const linux = notLinux ? findAll(linuxOnly, bare).find(
    (m) => !linuxConfigAfter.test(
      bare.slice(m.index + m[0].length, m.index + m[0].length + 40)
    )
  ) : void 0;
  if (linux) {
    put(linux.index, hit("needs_linux", "environment", act ? 4 : 3, linux[0]));
  }
  const x86 = mac ? find(x86Only, bare) : null;
  if (x86) put(x86.index, hit("needs_x86", "environment", act ? 4 : 3, x86[0]));
  const driver = find(driverText, bare);
  if (driver && act)
    put(driver.index, hit("driver_setup", "environment", 4, driver[0]));
  for (const s of errorLike.test(full) ? signatures : []) {
    const m = s.re.exec(full);
    if (m) {
      put(m.index, hit(`pasted_${s.id}`, s.category, 3, m[0]));
      break;
    }
  }
  const wreck = find(destructive, t);
  if (wreck)
    put(
      wreck.index,
      hit("destructive", "risky_experiment", act ? 4 : 2, wreck[0], wreck[0])
    );
  const device = find(rawDevice, t);
  if (device && !wreck) put(device.index, hit("raw_device", "risky_experiment", 2, device[0]));
  const kern = find(kernelText, bare);
  if (kern)
    put(
      kern.index,
      hit("kernel_change", "risky_experiment", act ? 3 : 1, kern[0], kern[0])
    );
  let time = 0;
  let work = 0;
  let heavyAt = -1;
  let heavyWhat = "";
  const cue = (m, w, isWork) => {
    if (!m) return;
    if (isWork) work += w;
    else time += w;
    if (heavyAt === -1 || m.index < heavyAt) {
      heavyAt = m.index;
      heavyWhat = m[0];
    }
  };
  const atLeast = (re, n) => findAll(re, bare).find((m) => Number(m[1]) >= n);
  for (const m of findAll(heavyPhrase, bare).slice(0, 2)) cue(m, 2, false);
  const length = atLeast(hours, 1);
  const stated = length && act && Number(length[1]) >= 2 && statedLength.test(before(bare, length.index, 30));
  cue(length, stated ? 3 : 2, false);
  cue(atLeast(minutes, 30), 2, false);
  cue(
    findAll(perItem, bare).find((m) => perItemSeconds(m) >= 3600),
    2,
    false
  );
  cue(find(heavyTask, bare), 1, true);
  const build = find(longBuild, bare);
  if (build) {
    const rest = bare.slice(build.index, build.index + build[0].length + 40);
    cue(build, fromScratch.test(rest) ? 4 : 3, true);
  }
  for (const m of findAll(loadTest, bare).slice(0, 2)) cue(m, 2, true);
  cue(find(heat, bare), 1, true);
  cue(atLeast(repeats, 10), 1, true);
  cue(
    findAll(batch, bare).find((m) => m[2] === "k" || Number(m[1]) >= 50),
    1,
    true
  );
  cue(find(wholeBatch, bare), 1, true);
  cue(atLeast(epochs, 20), 2, true);
  if (work > 0) {
    const of = (m) => volumeOf.test(bare.slice(m.index + m[0].length, m.index + m[0].length + 40));
    const size = findAll(volume, bare).slice(0, maxPasted).find((m) => /^t/.test(m[2]) || Number(m[1]) >= 200);
    if (size)
      cue(
        size,
        of(size) && (/^t/.test(size[2]) || Number(size[1]) >= 500) ? 3 : 1,
        true
      );
  }
  const heavy2 = work > 0 ? work + time : Math.min(time, 2);
  if (heavy2 > 0) {
    const w = doing ? Math.min(heavy2, 5) : heavy2 >= 4 ? 4 : Math.min(heavy2, 2);
    put(heavyAt, hit("heavy_job", "heavy_compute", w, heavyWhat, heavyWhat));
  }
  const typed = (x) => x[0].startsWith("`") || /:\/\//.test(x[0]) || !/^(?:curl|wget|iwr|irm|invoke)/.test(x[0]);
  for (const m of findAll(commandStart, t).filter(typed).slice(0, maxPasted)) {
    const c2 = classifyCommand(m[0].replace(/^`|`$/g, ""), ctx);
    if (c2.suggest && c2.category) {
      const pts = Math.min(Math.round(c2.score * 8), 6);
      put(
        m.index,
        hit("pasted_command", c2.category, pts, m[0], c2.subject ?? void 0)
      );
      break;
    }
  }
  const stop = find(abuse, full);
  const lan = find(lanScan, full);
  if (located.length === 0 && !global.some((h) => h.weight > 0)) {
    if (stop) return refuse([], hit("abuse", null, -10, stop[0]));
    return lan ? refuse([], hit("lan_scan", null, -10, lan[0])) : none;
  }
  const negatives = [];
  const negate = (re, id, weight) => {
    const seen = /* @__PURE__ */ new Set();
    for (const m of findAll(re, bare)) {
      const c2 = clauseOf(starts, m.index);
      if (seen.has(c2)) continue;
      seen.add(c2);
      negatives.push({ at: m.index, hit: hit(id, null, weight, m[0]) });
    }
  };
  negate(own, "own_project", -3);
  negate(docs, "writing_docs", -5);
  negate(tests, "writing_tests", -3);
  negate(edit, "editing_code", -2);
  negate(explainOnly, "explain_only", -3);
  const question = find(concept, bare);
  if (question) {
    const firm = !act || question.index === 0 && !iso && !away;
    const weight = doubt && about ? -2 : firm ? -5 : -2;
    global.push(hit("concept_question", null, weight, question[0]));
  }
  if (!iso && !away) {
    const ro = find(readOnly, bare);
    if (ro) global.push(hit("read_only", null, -6, ro[0]));
  }
  const inSecret = (at) => secret !== null && at >= secret.index && at < secret.index + secret[0].length;
  const api = findAll(hosted, bare).find(
    (m) => !inSecret(m.index) && !notHostedBefore.test(before(bare, m.index, 30))
  );
  if (api) {
    const strong2 = located.some(
      (l) => l.hit.category === "untrusted_code" && l.hit.weight >= 4
    );
    global.push(hit("hosted_api", null, strong2 ? -2 : -6, api[0]));
  }
  const remote = find(remoteTarget, bare);
  if (remote) global.push(hit("remote_target", null, -3, remote[0]));
  const plane = find(offline, bare);
  if (plane) global.push(hit("offline_use", null, -4, plane[0]));
  const perClause = /* @__PURE__ */ new Map();
  const empty = () => ({
    hits: [],
    code: 0,
    risky: 0,
    heavy: 0,
    own: 0,
    edit: 0,
    writing: 0,
    negs: []
  });
  for (const l of located) {
    const c2 = clauseOf(starts, l.at);
    const e = perClause.get(c2) ?? empty();
    if (l.hit.category === "heavy_compute") e.heavy += l.hit.weight;
    else if (l.hit.category === "risky_experiment") e.risky += l.hit.weight;
    else e.code += l.hit.weight;
    e.hits.push(l.hit);
    perClause.set(c2, e);
  }
  for (const n of negatives) {
    const e = perClause.get(clauseOf(starts, n.at));
    if (!e) continue;
    if (n.hit.id === "writing_docs" || n.hit.id === "writing_tests") e.writing += n.hit.weight;
    else if (n.hit.id === "own_project") e.own += n.hit.weight;
    else e.edit += n.hit.weight;
    e.negs.push(n.hit);
  }
  let points = global.reduce((s, h) => s + h.weight, 0);
  const kept = [...located.map((l) => l.hit), ...global];
  const live = [...global];
  for (const e of perClause.values()) {
    const code = e.code + e.own + e.edit + e.writing;
    const risky = e.risky + e.edit + e.writing;
    points += Math.max(0, code) + Math.max(0, risky) + (e.writing < 0 ? 0 : e.heavy);
    live.push(
      ...e.hits.filter((h) => {
        if (h.category === "heavy_compute") return e.writing >= 0;
        return (h.category === "risky_experiment" ? risky : code) > 0;
      })
    );
    kept.push(...e.negs);
  }
  if (stop) return refuse(kept, hit("abuse", null, -10, stop[0]));
  if (lan) return refuse(kept, hit("lan_scan", null, -10, lan[0]));
  const c = finish(kept, points, live);
  return c.subject ? { ...c, subject: asTyped(c.subject, clip(text)) } : c;
}
function perItemSeconds(m) {
  const count = Number(m[1].replace(",", ".")) * (m[2] ? 1e3 : 1);
  const unit = m[4][0] === "h" ? 3600 : m[4][0] === "m" ? 60 : 1;
  return count * Number(m[3]) * unit;
}

// packages/intent/src/hook.ts
var maxHintsPerSession = 2;
var stateTtlMs = 2 * 24 * 3600 * 1e3;
function envFrom(env) {
  const raw = (env.BUGNET_HINTS ?? env.CLAUDE_PLUGIN_OPTION_HINTS ?? "normal").toLowerCase();
  const hints = raw === "off" || raw === "quiet" ? raw : "normal";
  const base = env.CLAUDE_PLUGIN_DATA || join(tmpdir(), "bugnet-plugin");
  return { hints, stateDir: join(base, "hints"), platform: process.platform, arch: process.arch };
}
function stateFile(env, session) {
  return join(env.stateDir, `${session.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100)}.json`);
}
function loadState(env, session) {
  try {
    const s = JSON.parse(readFileSync(stateFile(env, session), "utf8"));
    const repos = s.clonedRepos;
    return {
      hinted: Array.isArray(s.hinted) ? s.hinted : [],
      clonedDirs: Array.isArray(s.clonedDirs) ? s.clonedDirs : [],
      clonedRepos: repos && typeof repos === "object" && !Array.isArray(repos) ? repos : {},
      bugnetUsed: s.bugnetUsed === true
    };
  } catch {
    return { hinted: [], clonedDirs: [], clonedRepos: {}, bugnetUsed: false };
  }
}
function saveState(env, session, state) {
  mkdirSync(env.stateDir, { recursive: true });
  writeFileSync(stateFile(env, session), JSON.stringify(state));
}
function prune(env, now) {
  if (Math.random() > 0.05) return;
  for (const f of readdirSync(env.stateDir)) {
    const p = join(env.stateDir, f);
    if (now - statSync(p).mtimeMs > stateTtlMs) rmSync(p, { force: true });
  }
}
function clonedDirs(command, cwd) {
  return clonesIn(command).map((c) => ({
    dir: isAbsolute(c.dir) ? c.dir : resolve(cwd, c.dir),
    repo: c.repo
  }));
}
function clonedAt(state, cwd, command) {
  const cds = [...clip(command).matchAll(/\bcd\s+(['"]?)([^\s'";&|]+)\1/g)].map(
    (m) => resolve(cwd, m[2])
  );
  for (const d of [cwd, ...cds]) {
    const c = state.clonedDirs.find((c2) => d === c2 || d.startsWith(`${c2}/`));
    if (c) return c;
  }
  return null;
}
function osOf(env) {
  if (env.platform === "darwin") return "macos";
  if (env.platform === "win32") return "windows";
  return "linux";
}
function mentionsBugnet(text) {
  return /bugnet/i.test(text);
}
function output(event, text) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: text }
  });
}
function runHook(mode, input, env, now = Date.now()) {
  if (env.hints === "off") return null;
  const session = input.session_id || "unknown";
  const cwd = input.cwd || process.cwd();
  const state = loadState(env, session);
  const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
  if (mode === "track") {
    if (/bugnet/i.test(input.tool_name ?? "")) state.bugnetUsed = true;
    const fresh = clonedDirs(command, cwd).filter((c2) => !state.clonedDirs.includes(c2.dir));
    if (fresh.length > 0 || state.bugnetUsed) {
      state.clonedDirs.push(...fresh.map((c2) => c2.dir));
      state.clonedDirs = state.clonedDirs.slice(-20);
      for (const c2 of fresh) state.clonedRepos[c2.dir] = c2.repo;
      state.clonedRepos = Object.fromEntries(
        state.clonedDirs.flatMap((d) => {
          const repo = state.clonedRepos[d];
          return repo ? [[d, repo]] : [];
        })
      );
      saveState(env, session, state);
    }
    return null;
  }
  if (state.bugnetUsed || state.hinted.length >= maxHintsPerSession) return null;
  if (env.hints === "quiet" && mode !== "failure") return null;
  const dir = mode === "prompt" ? null : clonedAt(state, cwd, command);
  const ctx = {
    os: osOf(env),
    arch: env.arch === "arm64" ? "arm64" : "x64",
    clonedThisSession: dir !== null,
    ...dir && state.clonedRepos[dir] ? { clonedRepo: state.clonedRepos[dir] } : {}
  };
  let c;
  if (mode === "prompt") {
    const prompt = input.prompt ?? "";
    if (mentionsBugnet(prompt)) return null;
    c = classifyPrompt(prompt, ctx);
  } else if (mode === "command") {
    if (mentionsBugnet(command)) return null;
    c = classifyCommand(command, ctx);
  } else {
    const error = typeof input.error === "string" ? input.error : "";
    c = classifyFailure(command, error, ctx);
  }
  if (!c.suggest || !c.category) return null;
  const key = c.category;
  if (state.hinted.includes(key)) return null;
  const text = hintFor(c, mode);
  if (!text) return null;
  state.hinted.push(key);
  saveState(env, session, state);
  try {
    prune(env, now);
  } catch {
  }
  const event = input.hook_event_name ?? { prompt: "UserPromptSubmit", command: "PreToolUse", failure: "PostToolUseFailure" }[mode];
  return output(event, text);
}
async function readStdin(limit = 1 << 20) {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > limit) break;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function main(argv) {
  try {
    const mode = argv[0];
    if (!["prompt", "command", "failure", "track"].includes(mode)) return;
    const input = JSON.parse(await readStdin());
    const out = runHook(mode, input, envFrom(process.env));
    if (out) process.stdout.write(`${out}
`);
  } catch {
  }
}

// packages/intent/src/hook-main.ts
await main(process.argv.slice(2));
