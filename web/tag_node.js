import { app } from "../../scripts/app.js";
import * as yaml from "https://cdn.jsdelivr.net/npm/js-yaml@4/+esm";

app.registerExtension({
    name: "Custom.TagNode",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "TagNode") return;

        async function loadYAML() {
            try {
                const res = await fetch("/extensions/comfyui_custom_node_sig/ko_KR.yaml");
                if (!res.ok) throw new Error("YAML load failed");
                return await res.text();
            } catch (e) {
                console.error("YAML 로딩 실패:", e);
                return "";
            }
        }

        const yamlText = await loadYAML();
        if (!yamlText) return;

        nodeType.prototype.onNodeCreated = async function () {
            console.log("[TagNode] 🔥 파일 버전 마커: v2-merge-fix"); // 이 로그가 안 뜨면 예전 파일이 로드된 것

            const node = this;
            const textWidget = node.widgets.find(w => w.name === "text");
            if (!textWidget) return;

            textWidget.hidden = true;
            textWidget.computeSize = () => [0, 0];

            let selectedTags = [];
            let currentGroup = null;
            let tagMap = {};
            let tagColorMap = {};

            // 🔥 히스토리
            let history = [];
            let historyIndex = -1;

            // 🔥 서버가 미리 스캔한 "태그 -> 이미지 파일 목록" 매니페스트
            // 이걸로 이미지 없는 태그는 아예 네트워크 요청을 안 하게 됨
            let imageManifest = {};
            let imageManifestLoaded = false;
            let manifestVersion = Date.now(); // 🔥 노드 로드 시점 기준 버전 (세션마다 새 값)

            async function loadImageManifest() {
                try {
                    const res = await fetch(`/tagnode/image_manifest?_=${manifestVersion}`); // 매니페스트 요청 자체도 캐시 방지
                    if (res.ok) {
                        imageManifest = await res.json();
                    }
                } catch (e) {
                    console.error("[TagNode] 이미지 매니페스트 로드 실패:", e);
                } finally {
                    imageManifestLoaded = true;
                }
            }

            loadImageManifest(); // 노드 생성 시 1회 호출

            // 🔥 이미지 프리뷰 관련
            const IMAGE_BASE_URL = "/extensions/comfyui_custom_node_sig/image/";
            const MAX_IMAGE_VARIANTS = 20; // apple_1.jpg ~ apple_20.jpg 까지 탐색
            const tagImageCache = new Map(); // tag -> [이미지url, ...] (한번 확인한 건 재요청 안 함)

            const sentenceTranslationCache = new Map();

            let previewToken = 0;

            function saveHistory() {
                history = history.slice(0, historyIndex + 1);
                history.push([...selectedTags]);
                historyIndex++;
            }

            function undo() {
                if (historyIndex > 0) {
                    historyIndex--;
                    selectedTags = [...history[historyIndex]];
                    updateText();
                    renderSelected();
                    if (currentGroup) renderTags(currentGroup);
                }
            }

            function redo() {
                if (historyIndex < history.length - 1) {
                    historyIndex++;
                    selectedTags = [...history[historyIndex]];
                    updateText();
                    renderSelected();
                    if (currentGroup) renderTags(currentGroup);
                }
            }

            // =========================
            // 텍스트 박스
            // =========================
            const textarea = document.createElement("textarea");

            function normalizeTag(raw) {
                let t = raw.trim();

                t = t.replace(/^[\(\[\{]+|[\)\]\}]+$/g, "");
                t = t.replace(/:(-?\d+(\.\d+)?)/, "");

                return t.trim();
            }

            // 🔥 콤마 분리 시 괄호 depth + 따옴표(") 내부는 분리하지 않도록 처리
            function smartSplit(text) {
                const result = [];
                let current = "";
                let depth = 0;
                let inQuote = false;

                for (let i = 0; i < text.length; i++) {
                    const c = text[i];

                    if (c === '"') inQuote = !inQuote;

                    if (!inQuote) {
                        if (c === "(" || c === "[" || c === "{") depth++;
                        if (c === ")" || c === "]" || c === "}") depth--;
                    }

                    if (c === "," && depth === 0 && !inQuote) {
                        result.push(current.trim());
                        current = "";
                    } else {
                        current += c;
                    }
                }

                if (current.trim()) result.push(current.trim());

                return result;
            }

            function parseTextToTags(text) {
                return smartSplit(text)
                    .map(t => t.trim())
                    .filter(t => t)
                    .map(t => {
                        const isGroup = /^[\(\[\{].*[\)\]\}]$/.test(t);

                        if (isGroup) {
                            // 🔥 괄호 제거 후 내부 다시 split
                            const inner = t.replace(/^[\(\[\{]+|[\)\]\}]+$/g, "");

                            const children = smartSplit(inner).map(child => ({
                                raw: child.trim(),
                                clean: normalizeTag(child)
                            }));

                            return {
                                raw: t,
                                clean: null,
                                isGroup: true,
                                children
                            };
                        }

                        return {
                            raw: t,
                            clean: normalizeTag(t),
                            isGroup: false
                        };
                    });
            }
            // =========================
            // 🔥 텍스트박스 우클릭 → 자동 번역
            // =========================
            let translateContextMenu = null;

            function closeTranslateContextMenu() {
                if (translateContextMenu) {
                    translateContextMenu.remove();
                    translateContextMenu = null;
                }
            }

            document.addEventListener("click", closeTranslateContextMenu);

            async function runTranslate() {
                const original = textarea.value;
                if (!original.trim()) return;

                const prevPlaceholder = textarea.placeholder;
                textarea.disabled = true;
                textarea.placeholder = "번역 중...";

                try {
                    const res = await fetch("/tagnode/translate", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ text: original, source: "ko", target: "en" })
                    });

                    if (!res.ok) throw new Error("번역 요청 실패");

                    const data = await res.json();
                    const translated = data.translated || "";

                    saveHistory(); // 🔥 번역 전 상태를 undo로 되돌릴 수 있게

                    textarea.value = translated;
                    textWidget.value = translated;
                    selectedTags = parseFullText(translated);

                    renderSelected();
                    if (currentGroup) renderTags(currentGroup);

                    node.setDirtyCanvas(true);

                    textarea.style.height = "auto";
                    textarea.style.height = textarea.scrollHeight + "px";

                } catch (e) {
                    console.error("[TagNode] 번역 실패:", e);
                    alert("번역에 실패했습니다.");
                } finally {
                    textarea.disabled = false;
                    textarea.placeholder = prevPlaceholder;
                }
            }

            async function callTranslate(text, source, target) {
                const res = await fetch("/tagnode/translate", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ text, source, target })
                });

                if (!res.ok) throw new Error("번역 요청 실패");

                const data = await res.json();
                return data.translated || "";
            }

            textarea.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                closeTranslateContextMenu();
                closeColorContextMenu(); // 다른 메뉴와 겹치지 않게

                const menu = document.createElement("div");
                Object.assign(menu.style, {
                    position: "fixed",
                    top: e.clientY + "px",
                    left: e.clientX + "px",
                    background: "#2a2a2a",
                    border: "1px solid #555",
                    borderRadius: "6px",
                    padding: "4px",
                    zIndex: "10000",
                    minWidth: "160px",
                    boxShadow: "0 2px 8px rgba(0,0,0,0.5)"
                });

                const translateItem = document.createElement("div");
                translateItem.innerText = "🌐 자동 번역 (한→영)";
                Object.assign(translateItem.style, {
                    padding: "6px 8px",
                    cursor: "pointer",
                    fontSize: "12px",
                    borderRadius: "4px"
                });

                translateItem.addEventListener("mouseenter", () => {
                    translateItem.style.background = "#444";
                });
                translateItem.addEventListener("mouseleave", () => {
                    translateItem.style.background = "transparent";
                });

                translateItem.onclick = async (ev) => {
                    ev.stopPropagation();
                    closeTranslateContextMenu();
                    await runTranslate();
                };

                menu.appendChild(translateItem);
                menu.addEventListener("click", (ev) => ev.stopPropagation());
                menu.addEventListener("contextmenu", (ev) => ev.preventDefault());

                document.body.appendChild(menu);
                translateContextMenu = menu;

                requestAnimationFrame(() => {
                    const rect = menu.getBoundingClientRect();
                    if (rect.right > window.innerWidth) {
                        menu.style.left = (window.innerWidth - rect.width - 8) + "px";
                    }
                    if (rect.bottom > window.innerHeight) {
                        menu.style.top = (window.innerHeight - rect.height - 8) + "px";
                    }
                });
            });
            // =========================
            // 🔥 자연어 문장 인식 관련
            // =========================

            // "." 포함된 YAML 태그(예: t.m.revolution, d.va, 0.0, >.< 등)를
            // 문장 분리 전에 보호(마스킹)하기 위한 정규식
            let periodProtectRegex = null;

            function buildPeriodProtection() {
                const dotTags = Object.keys(tagMap)
                    .filter(t => t.includes("."))
                    .sort((a, b) => b.length - a.length) // 긴 것부터 매칭 (부분 매칭 방지)
                    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")); // 정규식 이스케이프

                if (dotTags.length === 0) {
                    periodProtectRegex = null;
                    return;
                }
                periodProtectRegex = new RegExp(dotTags.join("|"), "gi");
            }

            function protectDotTags(text) {
                if (!periodProtectRegex) return text;
                return text.replace(periodProtectRegex, (m) => m.replace(/\./g, "\u0001"));
            }

            function restoreDotTags(text) {
                return text.replace(/\u0001/g, ".");
            }

            // 진짜 문장 경계(. ! ? 또는 줄바꿈)로 텍스트를 큰 덩어리(청크)로 분리
            // 마스킹된 "."은 여기서 걸리지 않으므로 안전
            function splitIntoChunks(text) {
                const protectedText = protectDotTags(text);

                // 🔥 줄바꿈도 문장 경계로 취급 (여러 줄에 걸친 문장 대응)
                const byLine = protectedText.split(/\r?\n/);

                const chunks = [];

                byLine.forEach(line => {
                    const parts = line.split(/([.!?])\s+/);

                    for (let i = 0; i < parts.length; i += 2) {
                        let chunk = parts[i] || "";
                        if (parts[i + 1]) chunk += parts[i + 1]; // 구분자(.!?) 다시 붙이기
                        chunk = chunk.trim();
                        if (chunk) chunks.push(restoreDotTags(chunk));
                    }
                });

                return chunks;
            }

            // YAML에 등록된 태그인지 확인 (가장 신뢰도 높은 신호)
            function isKnownTag(str) {
                const c = normalizeTag(str).toLowerCase();
                if (!c) return false;
                return Object.keys(tagMap).some(t => t.toLowerCase() === c);
            }

            // 태그처럼 생겼는지 (공백 없이 영숫자/언더스코어/콜론/괄호/마침표로만 구성)
            function looksLikeTagFormat(str) {
                const s = str.trim();
                if (!s) return false;
                if (/^[a-zA-Z0-9_\-:().]+$/.test(s) && !s.includes(" ")) return true;
                return false;
            }

            // 자연어 문장처럼 생겼는지 판별
            const SENTENCE_HINT_WORDS = /\b(is|are|was|were|has|have|had|said|says|say|this|that|she|he|they|it's|i'm|with|and|but|because|while|when|her|his|their|looking|wearing|holding)\b/i;

            function looksLikeSentence(str) {
                const s = str.trim();
                if (!s) return false;
                if (looksLikeTagFormat(s)) return false;

                const wordCount = s.split(/\s+/).filter(Boolean).length;
                if (wordCount < 2) return false;

                return SENTENCE_HINT_WORDS.test(s) || wordCount >= 4;
            }

            // 🔥 inSentenceContext: 바로 앞 조각이 이미 "문장"으로 판정되어
            // 현재 문장 버퍼가 채워져 있는 상태인지 여부.
            // 이미 문장 흐름 중이면, 뒤따르는 짧은 단어(예: "sad", "crying")도
            // 새로운 태그가 아니라 문장의 연속(형용사/절 등)으로 간주한다.
            // 단, YAML에 정식 등록된 태그라면 그건 명백한 신호이므로 우선한다.
            function classifySegment(str, inSentenceContext) {
                if (isKnownTag(str)) return "tag";
                if (inSentenceContext) return "sentence";
                if (looksLikeSentence(str)) return "sentence";
                return "tag";
            }

            // 마침표 기준으로 나눈 청크 하나를 처리:
            // 콤마로 쪼갠 뒤 태그/문장으로 분류하고,
            // 연속된 "문장" 조각은 콤마를 살려서 다시 하나로 합침
            function parseChunk(chunk) {
                const parts = smartSplit(chunk);

                const result = [];
                let sentenceBuffer = [];

                function flushSentence() {
                    if (sentenceBuffer.length > 0) {
                        result.push({
                            raw: sentenceBuffer.join(", "),
                            clean: null,
                            isGroup: false,
                            isSentence: true
                        });
                        sentenceBuffer = [];
                    }
                }

                // 🔥 순차적으로 분류 (이전 판정 결과가 다음 판정에 영향을 줌)
                parts.forEach(text => {
                    const inSentenceContext = sentenceBuffer.length > 0;
                    const type = classifySegment(text, inSentenceContext);

                    if (type === "sentence") {
                        sentenceBuffer.push(text);
                    } else {
                        flushSentence();
                        result.push(...parseTextToTags(text));
                    }
                });

                flushSentence();
                return result;
            }

            // 전체 텍스트 파싱 진입점: 문장 경계 → 청크 → 콤마 분류 → 재병합
            function parseFullText(text) {
                const chunks = splitIntoChunks(text);
                const result = [];

                chunks.forEach(chunk => {
                    result.push(...parseChunk(chunk));
                });

                return result;
            }

            function syncFromWidget() {
                if (!selectedDiv) return; // 안전장치

                const value = textWidget.value || "";
                textarea.value = value;
                selectedTags = parseFullText(value);

                renderSelected();

                if (currentGroup && currentGroup.tags) {
                    renderTags(currentGroup);
                }
            }

            // 🔥 문장(마침표/느낌표/물음표로 끝남) 뒤에는 콤마 대신 공백으로 연결,
            // 그 외에는 기존처럼 ", "로 연결
            function joinTags(tags) {
                let text = "";

                tags.forEach((item, i) => {
                    if (i === 0) {
                        text += item.raw;
                        return;
                    }

                    const prev = tags[i - 1];
                    const prevEndsSentence =
                        prev.isSentence && /[.!?]\s*$/.test(prev.raw);

                    text += (prevEndsSentence ? " " : ", ") + item.raw;
                });

                return text;
            }

            function updateText() {
                const newText = joinTags(selectedTags);
                textarea.value = newText;
                textWidget.value = newText;
                node.setDirtyCanvas(true);
            }

            textarea.value = textWidget.value || "";

            Object.assign(textarea.style, {
                width: "100%",
                height: "50px",
                resize: "vertical",
                boxSizing: "border-box",
                padding: "4px",
                background: "#1e1e1e",
                color: "#fff",
                border: "1px solid #555",
                borderRadius: "4px",
                overflowY: "auto"
            });

            textarea.addEventListener("input", () => {
                saveHistory(); // 🔥

                selectedTags = parseFullText(textarea.value);
                renderSelected();
                if (currentGroup) renderTags(currentGroup);

                textWidget.value = textarea.value;

                renderAutocomplete(); //자동완성

                textarea.style.height = "auto";
                textarea.style.height = textarea.scrollHeight + "px";
            });

            textarea.addEventListener("keydown", (e) => {
                if (e.ctrlKey && e.key.toLowerCase() === "z") {
                    e.preventDefault();
                    undo();
                }
                if (e.ctrlKey && e.key.toLowerCase() === "y") {
                    e.preventDefault();
                    redo();
                }

                // 🔥 Tab → 확장/축소 토글
                if (e.key === "Tab") {
                    e.preventDefault();
                    isExpanded = !isExpanded;
                    renderAutocomplete();
                    return;
                }

                // 🔥 방향키 이동
                if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key)) {

                    const isVisible = autocompleteDiv.style.display !== "none";

                    // 🔥 자동완성 안 보이면 → 완전 텍스트 모드
                    if (!isVisible) return;

                    // 🔥 리스트 모드
                    if (!isExpanded) {
                        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                            e.preventDefault();

                            const max = currentFiltered.length;

                            if (e.key === "ArrowDown") {
                                selectedIndex = (selectedIndex + 1) % max;
                            }
                            if (e.key === "ArrowUp") {
                                selectedIndex = (selectedIndex - 1 + max) % max;
                            }

                            renderAutocomplete();
                        }

                        // 좌우는 통과
                        return;
                    }

                    // 🔥 그리드 모드
                    e.preventDefault();

                    const max = currentFiltered.length;
                    const cols = 5;

                    let row = Math.floor(selectedIndex / cols);
                    let col = selectedIndex % cols;

                    if (e.key === "ArrowRight") col++;
                    if (e.key === "ArrowLeft") col--;
                    if (e.key === "ArrowDown") row++;
                    if (e.key === "ArrowUp") row--;

                    if (col < 0) col = 0;
                    if (col >= cols) col = cols - 1;

                    let newIndex = row * cols + col;

                    if (newIndex >= max) newIndex = max - 1;
                    if (newIndex < 0) newIndex = 0;

                    selectedIndex = newIndex;

                    renderAutocomplete();
                }

                // 🔥 Enter → 선택 적용
                if (e.key === "Enter") {
                    if (selectedIndex >= 0 && currentFiltered[selectedIndex]) 
                        { 
                            e.preventDefault(); 
                            const index = selectedIndex >= 0 ? selectedIndex : 0; 
                            applyAutocomplete(currentFiltered[selectedIndex].tag); 
                        }
                }
            });

            textarea.addEventListener("focus", () => {
                syncFromWidget();

                // 자동완성 위치 설정
                autocompleteDiv.style.top =
                    textarea.offsetTop + textarea.offsetHeight + "px";
                autocompleteDiv.style.left =
                    textarea.offsetLeft + "px";
            });

            // =========================
            // 선택 아이템 태그 UI
            // =========================
            // 🔥 드래그 중 드롭 위치를 보여주는 세로선 인디케이터
            const selectedDiv = document.createElement("div");

            Object.assign(selectedDiv.style, {
                display: "flex",
                flexWrap: "wrap",
                gap: "4px",
                flexShrink: "0",
                position: "relative"
            });

            const dropIndicator = document.createElement("div");

            Object.assign(dropIndicator.style, {
                position: "absolute",
                width: "2px",
                background: "rgba(255, 255, 255, 0.7)",
                borderRadius: "1px",
                pointerEvents: "none",
                display: "none",
                zIndex: "10"
            });

            selectedDiv.appendChild(dropIndicator);

            let dragIndex = null;

            // =========================
            // 🔥 문장 칩 우클릭 → 한글 번역 (칩 아래에 번역 서브텍스트 추가)
            // =========================
            let sentenceMenu = null;

            function closeSentenceMenu() {
                if (sentenceMenu) {
                    sentenceMenu.remove();
                    sentenceMenu = null;
                }
            }

            document.addEventListener("click", closeSentenceMenu);

            // 🔥 빈 공간 우클릭 → 전체 문장 일괄 번역
            async function translateAllSentences() {
                // 🔥 문장(isSentence) + YAML에 없는 일반 태그(unknown tag) 둘 다 대상으로
                const targets = selectedTags.filter(item => {
                    if (item.isGroup) return false;
                    if (sentenceTranslationCache.has(item.raw)) return false;

                    if (item.isSentence) return true;

                    // 일반 태그인데 YAML(tagMap)에 등록 안 된 경우 = 번역 대상
                    const tag = item.clean;
                    return tag && !(tag in tagMap);
                });

                if (targets.length === 0) return;

                await Promise.all(
                    targets.map(async (item) => {
                        try {
                            const translated = await callTranslate(item.raw, "en", "ko");
                            sentenceTranslationCache.set(item.raw, translated);
                        } catch (e) {
                            console.error("[TagNode] 번역 실패:", item.raw, e);
                        }
                    })
                );

                renderSelected();
            }
            let bulkTranslateMenu = null;

            function closeBulkTranslateMenu() {
                if (bulkTranslateMenu) {
                    bulkTranslateMenu.remove();
                    bulkTranslateMenu = null;
                }
            }

            document.addEventListener("click", closeBulkTranslateMenu);

            function showBulkTranslateMenu(x, y) {
                closeBulkTranslateMenu();
                closeColorContextMenu();
                closeSentenceMenu();

                const menu = document.createElement("div");
                Object.assign(menu.style, {
                    position: "fixed",
                    top: y + "px",
                    left: x + "px",
                    background: "#2a2a2a",
                    border: "1px solid #555",
                    borderRadius: "6px",
                    padding: "4px",
                    zIndex: "10000",
                    minWidth: "140px",
                    boxShadow: "0 2px 8px rgba(0,0,0,0.5)"
                });

                const item = document.createElement("div");
                item.innerText = "🌐 한글로 전체 번역";
                Object.assign(item.style, {
                    padding: "6px 8px",
                    cursor: "pointer",
                    fontSize: "12px",
                    borderRadius: "4px"
                });
                item.addEventListener("mouseenter", () => item.style.background = "#444");
                item.addEventListener("mouseleave", () => item.style.background = "transparent");

                item.onclick = async (ev) => {
                    ev.stopPropagation();
                    closeBulkTranslateMenu();

                    item.innerText = "번역 중...";
                    await translateAllSentences();
                };

                menu.appendChild(item);
                menu.addEventListener("click", (ev) => ev.stopPropagation());
                menu.addEventListener("contextmenu", (ev) => ev.preventDefault());

                document.body.appendChild(menu);
                bulkTranslateMenu = menu;

                requestAnimationFrame(() => {
                    const rect = menu.getBoundingClientRect();
                    if (rect.right > window.innerWidth) {
                        menu.style.left = (window.innerWidth - rect.width - 8) + "px";
                    }
                    if (rect.bottom > window.innerHeight) {
                        menu.style.top = (window.innerHeight - rect.height - 8) + "px";
                    }
                });
            }

            // 🔥 selectedDiv "빈 공간"(칩이 아닌 곳)에서만 우클릭 시 발동
            selectedDiv.addEventListener("contextmenu", (e) => {
                if (e.target !== selectedDiv && e.target !== dropIndicator) return;

                e.preventDefault();
                showBulkTranslateMenu(e.clientX, e.clientY);
            });

            function showSentenceTranslateMenu(e, item) {
                e.preventDefault();
                e.stopPropagation();
                closeSentenceMenu();
                closeColorContextMenu();

                const menu = document.createElement("div");
                Object.assign(menu.style, {
                    position: "fixed",
                    top: e.clientY + "px",
                    left: e.clientX + "px",
                    background: "#2a2a2a",
                    border: "1px solid #555",
                    borderRadius: "6px",
                    padding: "4px",
                    zIndex: "10000",
                    minWidth: "120px",
                    boxShadow: "0 2px 8px rgba(0,0,0,0.5)"
                });

                const translateItem = document.createElement("div");
                translateItem.innerText = "🌐 한글 번역";
                Object.assign(translateItem.style, {
                    padding: "6px 8px",
                    cursor: "pointer",
                    fontSize: "12px",
                    borderRadius: "4px"
                });
                translateItem.addEventListener("mouseenter", () => translateItem.style.background = "#444");
                translateItem.addEventListener("mouseleave", () => translateItem.style.background = "transparent");

                translateItem.onclick = async (ev) => {
                    ev.stopPropagation();
                    closeSentenceMenu();

                    try {
                        const translated = await callTranslate(item.raw, "en", "ko");
                        sentenceTranslationCache.set(item.raw, translated); // 🔥 원문 기준으로 캐시 저장
                        renderSelected(); // 🔥 다시 그려서 서브텍스트 반영
                    } catch (err) {
                        console.error("[TagNode] 번역 실패:", err);
                        alert("번역에 실패했습니다.");
                    }
                };

                menu.appendChild(translateItem);
                menu.addEventListener("click", (ev) => ev.stopPropagation());
                menu.addEventListener("contextmenu", (ev) => ev.preventDefault());

                document.body.appendChild(menu);
                sentenceMenu = menu;

                requestAnimationFrame(() => {
                    const rect = menu.getBoundingClientRect();
                    if (rect.right > window.innerWidth) {
                        menu.style.left = (window.innerWidth - rect.width - 8) + "px";
                    }
                    if (rect.bottom > window.innerHeight) {
                        menu.style.top = (window.innerHeight - rect.height - 8) + "px";
                    }
                });
            }
            function handleDragStart(e) {
                const el = e.currentTarget;
                dragIndex = Number(el.dataset.index);
                e.dataTransfer.setData("text/plain", "");

                el.addEventListener("dragend", () => {
                    dropIndicator.style.display = "none";
                }, { once: true });
            }

            selectedDiv.addEventListener("drop", (e) => {
                e.preventDefault();
                if (dragIndex === null) return;

                saveHistory();

                const { closestIndex } = calcClosestDropIndex(e.clientX, e.clientY);

                const moved = selectedTags.splice(dragIndex, 1)[0];
                let insertAt = closestIndex;
                if (dragIndex < closestIndex) insertAt--;
                selectedTags.splice(insertAt, 0, moved);

                dragIndex = null;
                dropIndicator.style.display = "none"; // 🔥 드롭 후 인디케이터 숨김

                updateText();
                renderSelected();
                if (currentGroup) renderTags(currentGroup);
            });

            selectedDiv.addEventListener("dragleave", (e) => {
                // selectedDiv 영역을 완전히 벗어났을 때만 숨김 (자식 요소 간 이동은 무시)
                if (!selectedDiv.contains(e.relatedTarget)) {
                    dropIndicator.style.display = "none";
                }
            });

            selectedDiv.addEventListener("dragover", (e) => e.preventDefault());

            selectedDiv.addEventListener("dragover", (e) => {
                e.preventDefault();
                if (dragIndex === null) return;

                const { closestRect, insertBefore, items } = calcClosestDropIndex(e.clientX, e.clientY);
                const wrapperRect = selectedDiv.getBoundingClientRect();

                if (items.length === 0 || !closestRect) {
                    dropIndicator.style.display = "none";
                    return;
                }

                // 🔥 ComfyUI 캔버스 zoom(transform: scale)을 보정
                // selectedDiv.offsetWidth(스케일 미적용 실제 px) vs wrapperRect.width(스케일 적용된 화면 px) 비율로 역산
                const scale = wrapperRect.width / selectedDiv.offsetWidth || 1;

                const rawX = (insertBefore ? closestRect.left : closestRect.right) - wrapperRect.left;
                const rawTop = closestRect.top - wrapperRect.top;
                const rawHeight = closestRect.height;

                const lineX = rawX / scale;
                const lineTop = rawTop / scale;
                const lineHeight = rawHeight / scale;

                dropIndicator.style.left = `${lineX - 1}px`;
                dropIndicator.style.top = `${lineTop}px`;
                dropIndicator.style.height = `${lineHeight}px`;
                dropIndicator.style.display = "block";
            });

            function calcClosestDropIndex(clientX, clientY) {
                const items = Array.from(selectedDiv.children)
                    .filter(el => el.dataset.index !== undefined && el !== dropIndicator);

                if (items.length === 0) {
                    return { closestIndex: 0, closestRect: null, insertBefore: true, items };
                }

                // 🔥 먼저 같은 "줄"에 있는 아이템만 후보로 좁힘 (Y좌표가 겹치는 것들)
                let sameRowItems = items.filter(el => {
                    const rect = el.getBoundingClientRect();
                    return clientY >= rect.top && clientY <= rect.bottom;
                });

                // 같은 줄에 아무것도 없으면(빈 줄 등) 전체에서 Y거리 기준으로 가장 가까운 줄을 찾음
                if (sameRowItems.length === 0) {
                    let minRowDist = Infinity;
                    let targetRow = null;

                    items.forEach(el => {
                        const rect = el.getBoundingClientRect();
                        const rowCenterY = rect.top + rect.height / 2;
                        const dist = Math.abs(clientY - rowCenterY);
                        if (dist < minRowDist) {
                            minRowDist = dist;
                            targetRow = rect.top;
                        }
                    });

                    sameRowItems = items.filter(el => {
                        const rect = el.getBoundingClientRect();
                        return Math.abs(rect.top - targetRow) < 2; // 같은 줄로 간주
                    });
                }

                // 🔥 같은 줄 안에서는 X좌표로만 가장 가까운 위치 찾기
                let closestIndex = items.length;
                let minDistance = Infinity;
                let closestRect = null;
                let insertBefore = true;

                sameRowItems.forEach((el) => {
                    const rect = el.getBoundingClientRect();
                    const cx = rect.left + rect.width / 2;
                    const dist = Math.abs(clientX - cx);

                    if (dist < minDistance) {
                        minDistance = dist;

                        const idx = Number(el.dataset.index);
                        const before = clientX < cx;

                        closestIndex = before ? idx : idx + 1;
                        closestRect = rect;
                        insertBefore = before;
                    }
                });

                return { closestIndex, closestRect, insertBefore, items };
            }

            function renderSelected() {
                // 🔥 innerHTML로 전체 초기화하면 dropIndicator도 같이 삭제되므로,
                // 태그 칩만 별도로 제거하고 인디케이터는 유지
                Array.from(selectedDiv.children).forEach(child => {
                    if (child !== dropIndicator) child.remove();
                });

                selectedTags.forEach((item, index) => {
                if (item.isSentence) {
                    // 🔥 자연어 문장 블록 렌더링
                    const chip = document.createElement("div");

                    chip.dataset.index = index;
                    chip.draggable = true;
                    chip.addEventListener("dragstart", handleDragStart);

                    // 🔥 원문 + (있으면) 번역 서브텍스트를 같이 렌더링
                    const translated = sentenceTranslationCache.get(item.raw);

                    const originalLine = document.createElement("div");
                    originalLine.innerText = item.raw;

                    chip.appendChild(originalLine);

                    if (translated) {
                        const translatedLine = document.createElement("div");
                        translatedLine.innerText = translated;
                        Object.assign(translatedLine.style, {
                            fontSize: "10px",
                            opacity: "0.7",
                            fontStyle: "normal",
                            marginTop: "2px"
                        });
                        chip.appendChild(translatedLine);
                    }

                    Object.assign(chip.style, {
                        padding: "4px 6px",
                        background: "#3a3a4a",
                        borderRadius: "6px",
                        cursor: "grab",
                        fontStyle: "italic",
                        fontSize: "12px",
                        maxWidth: "100%",
                        whiteSpace: "normal",
                        wordBreak: "break-word"
                    });

                    chip.onclick = () => {
                        saveHistory();

                        selectedTags = selectedTags.filter((_, i) => i !== index);
                        sentenceTranslationCache.delete(item.raw); // 🔥 칩 삭제 시 캐시도 정리

                        updateText();
                        renderSelected();
                        if (currentGroup) renderTags(currentGroup);
                    };

                    // 🔥 우클릭 → 번역 메뉴
                    chip.addEventListener("contextmenu", (e) => {
                        showSentenceTranslateMenu(e, item);
                    });

                    selectedDiv.appendChild(chip);
                } else if (item.isGroup) {
                        const container = document.createElement("div");
                        container.dataset.index = index;
                        container.draggable = true;
                        container.addEventListener("dragstart", handleDragStart);

                        Object.assign(container.style, {
                            display: "flex",
                            alignItems: "center",
                            gap: "0px"
                        });

                        item.children.forEach((child, i) => {
                            const tag = child.clean;
                            const display = child.raw.replace(/^[\(\[\{]+|[\)\]\}]+$/g, "");

                            const chip = document.createElement("div");

                            chip.innerHTML = `
                                <div style="font-size:12px; font-weight:bold;">${display}</div>
                                <div style="font-size:10px; opacity:0.7; min-height:12px;">
                                    ${tagMap[tag] || ""}
                                </div>
                            `;

                            Object.assign(chip.style, {
                                padding: "4px 6px",
                                background: tagColorMap[tag] || "rgb(61,61,61)",
                                borderRadius: "6px",
                                display: "flex",
                                flexDirection: "column"
                            });

                            container.onclick = () => {
                                saveHistory();

                                selectedTags = selectedTags.filter((_, i) => i !== index);

                                updateText();
                                renderSelected();
                                if (currentGroup) renderTags(currentGroup);
                            };

                            container.appendChild(chip);

                            if (i < item.children.length - 1) {
                                const line = document.createElement("div");
                                Object.assign(line.style, {
                                    width: "8px",
                                    height: "7px",
                                    background: "#ccc",
                                    opacity: "0.6"
                                });
                                container.appendChild(line);
                            }
                        });

                        selectedDiv.appendChild(container);
                    } else {
                        // 🔹 기존 일반 태그 렌더링
                        const tag = item.clean;
                        const display = item.raw.replace(/^[\(\[\{]+|[\)\]\}]+$/g, "");
                        const isUnknownTag = !(tag in tagMap);

                        const chip = document.createElement("div");

                        chip.dataset.index = index; 
                        chip.draggable = true;
                        chip.addEventListener("dragstart", handleDragStart);

                        // 🔥 YAML 설명이 없으면 번역 캐시에서 찾아보기
                        const descText = tagMap[tag] || sentenceTranslationCache.get(tag) || "";

                        chip.innerHTML = `
                            <div style="display:flex; justify-content:space-between; gap:6px;">
                                <span style="font-size:12px; font-weight:bold;">${display}</span>
                                <span style="font-size:11px; opacity:0.7;">
                                    ${tagCountMap[tag] || ""}
                                </span>
                            </div>
                            <div style="font-size:10px; opacity:0.7;">
                                ${descText}
                            </div>
                        `;

                        Object.assign(chip.style, {
                            padding: "4px 6px",
                            background: tagColorMap[tag] || "rgb(61,61,61)",
                            borderRadius: "6px",
                            cursor: "grab",
                            display: "flex",
                            flexDirection: "column"
                        });

                        chip.onclick = () => {
                            saveHistory();
                            selectedTags = selectedTags.filter((_, i) => i !== index);
                            updateText();
                            renderSelected();
                            if (currentGroup) renderTags(currentGroup);
                        };

                        // 🔥 YAML에 없는 태그(=일반 단어)는 우클릭으로 번역 가능하게
                        if (isUnknownTag) {
                            chip.addEventListener("contextmenu", (e) => {
                                showSentenceTranslateMenu(e, item); // item.raw 기준으로 callTranslate 호출됨
                            });
                        }

                        selectedDiv.appendChild(chip);
                    }
                });
            }


            // =========================
            // 검색 기능
            // =========================            
            const searchInput = document.createElement("input");

            searchInput.type = "text";
            searchInput.placeholder = "태그 검색...";

            Object.assign(searchInput.style, {
                width: "100%",
                padding: "6px",
                boxSizing: "border-box",
                background: "#1e1e1e",
                color: "#fff",
                border: "1px solid #555",
                borderRadius: "4px"
            });

            function renderSearch(keyword) {

                keyword = keyword.trim().toLowerCase();

                if (!keyword) {
                    renderCategories();
                    groupDiv.innerHTML = "";
                    tagDiv.innerHTML = "";
                    return;
                }

                categoryDiv.innerHTML = "";
                groupDiv.innerHTML = "";
                tagDiv.innerHTML = "";

                const matchedCategories = new Map();

                searchIndex.forEach(item => {

                    const hit =
                        item.tag.toLowerCase().includes(keyword) ||
                        item.desc.toLowerCase().includes(keyword);

                    if (!hit) return;

                    if (!matchedCategories.has(item.category)) {
                        matchedCategories.set(item.category, []);
                    }

                    matchedCategories.get(item.category).push(item);
                });

                matchedCategories.forEach((items, categoryName) => {

                    categoryDiv.appendChild(
                        createItem(categoryName, () => {
                            renderSearchGroups(items);
                        })
                    );

                });
            }

            function renderSearchGroups(items) {

                groupDiv.innerHTML = "";
                tagDiv.innerHTML = "";

                const groups = new Map();

                items.forEach(item => {

                    if (!groups.has(item.group)) {
                        groups.set(item.group, []);
                    }

                    groups.get(item.group).push(item);
                });

                groups.forEach((tags, groupName) => {

                    groupDiv.appendChild(
                        createItem(groupName, () => {
                            renderSearchTags(tags);
                        })
                    );

                });
            }

            function renderSearchTags(tags) {

                tagDiv.innerHTML = "";

                tags.forEach(item => {

                    const div = document.createElement("div");

                    div.innerHTML = `
                        <div style="display:flex;justify-content:space-between;">
                            <b>${item.tag}</b>
                            <span style="font-size:11px;opacity:0.7;">
                                ${tagCountMap[item.tag] || ""}
                            </span>
                        </div>
                        <small>${item.desc}</small>
                    `;

                    Object.assign(div.style, {
                        padding: "6px",
                        marginBottom: "4px",
                        borderRadius: "6px",
                        background: item.color,
                        cursor: "pointer"
                    });

                    div.onclick = () => {

                        saveHistory();

                        if (!selectedTags.some(t => t.clean === item.tag)) {

                            selectedTags.push({
                                raw: item.tag,
                                clean: item.tag,
                                isGroup: false
                            });

                            updateText();
                            renderSelected();
                        }
                    };

                    attachImagePreview(div, item.tag);

                    tagDiv.appendChild(div);
                });
            }

            searchInput.addEventListener("input", () => {
                renderSearch(searchInput.value);
            });
            // =========================
            // 메인 영역
            // =========================
            const mainArea = document.createElement("div");

            Object.assign(mainArea.style, {
                display: "flex",
                gap: "6px",
                flex: "1",
                overflow: "hidden"
            });

            function createPanel(flex) {
                const div = document.createElement("div");
                Object.assign(div.style, {
                    flex,
                    border: "1px solid #555",
                    padding: "4px",
                    background: "#222",
                    overflowY: "auto"
                });
                return div;
            }

            const categoryDiv = createPanel("1");
            const groupDiv = createPanel("1");
            const tagDiv = createPanel("2");

            mainArea.append(categoryDiv, groupDiv, tagDiv);

            // =========================
            // YAML 처리
            // =========================
            const data = yaml.load(yamlText);

            if (!Array.isArray(data)) {
                console.error("YAML format error:", data);
                return;
            }

            // =========================
            // 🔥 그룹 색상 사용자 오버라이드 (localStorage 영구 저장)
            // =========================
            const COLOR_OVERRIDE_KEY = "TagNode_groupColorOverrides";

            function loadColorOverrides() {
                try {
                    const raw = localStorage.getItem(COLOR_OVERRIDE_KEY);
                    return raw ? JSON.parse(raw) : {};
                } catch (e) {
                    console.error("색상 오버라이드 로드 실패:", e);
                    return {};
                }
            }

            function saveColorOverrides(overrides) {
                try {
                    localStorage.setItem(COLOR_OVERRIDE_KEY, JSON.stringify(overrides));
                } catch (e) {
                    console.error("색상 오버라이드 저장 실패:", e);
                }
            }

            let colorOverrides = loadColorOverrides();

            function groupKey(cat, group) {
                return `${cat.name}::${group.name}`;
            }

            // YAML 원본 색상을 따로 백업(초기화 버튼용) + 저장된 오버라이드가 있으면 적용
            let originalGroupColors = {};

            data.forEach(cat => {
                if (!cat.groups) return;

                cat.groups.forEach(group => {
                    const key = groupKey(cat, group);
                    originalGroupColors[key] = group.color || "#5a3a1a";

                    if (colorOverrides[key]) {
                        group.color = colorOverrides[key]; // 🔥 사용자가 바꾼 색상 적용
                    }
                });
            });

            // rgba(r,g,b,a) 문자열 ↔ hex/alpha 변환 (color input은 alpha 미지원이라 분리)
            function parseColorToHexAlpha(colorStr) {
                if (!colorStr) return { hex: "#5a3a1a", alpha: 1 };

                const m = colorStr.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/i);
                if (m) {
                    const r = parseInt(m[1], 10);
                    const g = parseInt(m[2], 10);
                    const b = parseInt(m[3], 10);
                    const a = m[4] !== undefined ? parseFloat(m[4]) : 1;
                    const hex = "#" + [r, g, b].map(v => v.toString(16).padStart(2, "0")).join("");
                    return { hex, alpha: isNaN(a) ? 1 : a };
                }

                if (/^#[0-9a-f]{6}$/i.test(colorStr)) {
                    return { hex: colorStr, alpha: 1 };
                }

                return { hex: "#5a3a1a", alpha: 1 };
            }

            function hexAlphaToRgba(hex, alpha) {
                const r = parseInt(hex.slice(1, 3), 16);
                const g = parseInt(hex.slice(3, 5), 16);
                const b = parseInt(hex.slice(5, 7), 16);
                return `rgba(${r}, ${g}, ${b}, ${alpha})`;
            }

            // 🔥 서버에 색상 변경 요청 (YAML 파일에 실제로 저장)
            async function persistColorToYAML(cat, group, newColor) {
                try {
                    const res = await fetch("/tagnode/update_color", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            category: cat.name,
                            group: group.name,
                            color: newColor
                        })
                    });

                    if (!res.ok) {
                        const err = await res.json().catch(() => ({}));
                        throw new Error(err.error || "저장 실패");
                    }
                } catch (e) {
                    console.error("[TagNode] YAML 색상 서버 저장 실패:", e);
                }
            }

            function updateGroupColor(cat, group, newColor) {
                group.color = newColor;

                if (group.tags) {
                    Object.keys(group.tags).forEach(tag => {
                        tagColorMap[tag] = newColor;
                    });
                }

                colorOverrides[groupKey(cat, group)] = newColor;
                saveColorOverrides(colorOverrides); // 로컬 즉시 반영(빠른 UI 반응용)

                persistColorToYAML(cat, group, newColor); // 🔥 서버 파일에도 영구 저장

                renderGroups(cat);
                if (currentGroup === group) renderTags(group);
                renderSelected();
            }

            function resetGroupColor(cat, group) {
                delete colorOverrides[groupKey(cat, group)];
                saveColorOverrides(colorOverrides);

                const original = originalGroupColors[groupKey(cat, group)] || "#5a3a1a";
                updateGroupColor(cat, group, original);
            }

            // 우클릭 색상 변경 팝업
            let colorContextMenu = null;

            function closeColorContextMenu() {
                if (colorContextMenu) {
                    colorContextMenu.remove();
                    colorContextMenu = null;
                }
            }

            document.addEventListener("click", closeColorContextMenu);

            function showGroupColorMenu(e, cat, group) {
                e.preventDefault();
                e.stopPropagation();
                closeColorContextMenu();

                const menu = document.createElement("div");
                Object.assign(menu.style, {
                    position: "fixed",
                    top: e.clientY + "px",
                    left: e.clientX + "px",
                    background: "#2a2a2a",
                    border: "1px solid #555",
                    borderRadius: "6px",
                    padding: "8px",
                    zIndex: "10000",
                    display: "flex",
                    flexDirection: "column",
                    gap: "6px",
                    minWidth: "170px",
                    boxShadow: "0 2px 8px rgba(0,0,0,0.5)"
                });

                const title = document.createElement("div");
                title.innerText = `${group.name} 색상`;
                Object.assign(title.style, { fontSize: "11px", opacity: "0.7" });
                menu.appendChild(title);

                const { hex, alpha } = parseColorToHexAlpha(group.color);

                const colorRow = document.createElement("div");
                Object.assign(colorRow.style, { display: "flex", alignItems: "center", gap: "6px" });

                const colorInput = document.createElement("input");
                colorInput.type = "color";
                colorInput.value = hex;
                Object.assign(colorInput.style, {
                    width: "36px",
                    height: "24px",
                    padding: "0",
                    border: "none",
                    cursor: "pointer",
                    background: "transparent"
                });

                const alphaInput = document.createElement("input");
                alphaInput.type = "range";
                alphaInput.min = "0.1";
                alphaInput.max = "1";
                alphaInput.step = "0.05";
                alphaInput.value = alpha;
                alphaInput.style.flex = "1";

                function applyColor() {
                    const newColor = hexAlphaToRgba(colorInput.value, parseFloat(alphaInput.value));
                    updateGroupColor(cat, group, newColor);
                }

                colorInput.addEventListener("input", applyColor);
                alphaInput.addEventListener("input", applyColor);

                colorRow.append(colorInput, alphaInput);
                menu.appendChild(colorRow);

                const resetBtn = document.createElement("div");
                resetBtn.innerText = "기본색으로 초기화";
                Object.assign(resetBtn.style, {
                    fontSize: "11px",
                    padding: "4px",
                    cursor: "pointer",
                    borderTop: "1px solid #444",
                    marginTop: "2px",
                    opacity: "0.8"
                });
                resetBtn.onclick = (ev) => {
                    ev.stopPropagation();
                    resetGroupColor(cat, group);
                    closeColorContextMenu();
                };
                menu.appendChild(resetBtn);

                menu.addEventListener("click", (ev) => ev.stopPropagation());
                menu.addEventListener("contextmenu", (ev) => ev.preventDefault());

                document.body.appendChild(menu);
                colorContextMenu = menu;

                // 화면 밖으로 나가지 않도록 위치 보정
                requestAnimationFrame(() => {
                    const rect = menu.getBoundingClientRect();
                    if (rect.right > window.innerWidth) {
                        menu.style.left = (window.innerWidth - rect.width - 8) + "px";
                    }
                    if (rect.bottom > window.innerHeight) {
                        menu.style.top = (window.innerHeight - rect.height - 8) + "px";
                    }
                });
            }

            let tagCountMap = {};

            let isExpanded = false;
            let selectedIndex = -1;
            let currentFiltered = [];

            function getCurrentInput() {
                const parts = textarea.value.split(",");
                return parts[parts.length - 1].trim().toLowerCase();
            }

            function renderAutocomplete() {
                const keyword = getCurrentInput();

                if (!keyword) {
                    autocompleteDiv.style.display = "none";
                    selectedIndex = -1;
                    return;
                }

                // 🔥 추가: 완전히 일치하는 태그가 있으면 자동완성 숨김
                const exactMatch = allTags.some(t => t.tag.toLowerCase() === keyword);

                if (exactMatch) {
                    autocompleteDiv.style.display = "none";
                    selectedIndex = -1;
                    return;
                }

                // 🔥 starts + includes 정렬
                let starts = allTags.filter(t =>
                    t.tag.toLowerCase().startsWith(keyword) &&
                    !selectedTags.includes(t.tag)
                );

                let includes = allTags.filter(t =>
                    !t.tag.toLowerCase().startsWith(keyword) &&
                    t.tag.toLowerCase().includes(keyword) &&
                    !selectedTags.includes(t.tag)
                );

                let filtered = [...starts, ...includes];

                if (filtered.length === 0) {
                    autocompleteDiv.style.display = "none";
                    selectedIndex = -1;
                    return;
                }

                if (!isExpanded) {
                    filtered = filtered.slice(0, 10);
                    autocompleteDiv.style.display = "block";
                    autocompleteDiv.style.gridTemplateColumns = "1fr";
                } else {
                    autocompleteDiv.style.display = "grid";
                    autocompleteDiv.style.gridTemplateColumns = "repeat(5, 1fr)";
                }

                currentFiltered = filtered;

                if (selectedIndex >= filtered.length) selectedIndex = 0;
                if (selectedIndex === -1 && filtered.length > 0) {
                    selectedIndex = 0;
                }

                autocompleteDiv.innerHTML = "";

                filtered.forEach((item, i) => {
                    const div = document.createElement("div");
                    div.innerText = item.tag;

                    Object.assign(div.style, {
                        padding: "4px",
                        cursor: "pointer",
                        borderBottom: "1px solid #444",
                        background: i === selectedIndex ? "#555" : "transparent"
                    });

                    div.onclick = () => {
                        applyAutocomplete(item.tag);
                    };

                    autocompleteDiv.appendChild(div);
                });
            }

            function applyAutocomplete(tag) {
                let parts = textarea.value.split(",");
                parts[parts.length - 1] = " " + tag;

                const newText = parts.map(t => t.trim()).filter(t => t).join(", ");

                textarea.value = newText;
                textWidget.value = newText;
                selectedTags = parseFullText(newText);

                updateText();
                renderSelected();
                if (currentGroup) renderTags(currentGroup);

                autocompleteDiv.style.display = "none";
            }

            data.forEach(cat => {
                if (!cat.groups) return;

                cat.groups.forEach(group => {
                    if (!group || !group.tags) return;

                    Object.entries(group.tags).forEach(([tag, desc]) => {
                        // 🔥 [숫자] 파싱 - trim 후 매칭, 끝에 공백/줄바꿈이 있어도 인식되도록 완화
                        desc = String(desc ?? "").trim();

                        const match = desc.match(/\[([^\[\]]*)\]\s*$/);

                        let cleanDesc = desc;
                        let count = null;

                        if (match) {
                            count = match[1].trim(); // 1.3K, 8.3M 이런 값
                            cleanDesc = desc.replace(/\s*\[[^\[\]]*\]\s*$/, ""); // 설명에서 제거
                        }

                        // 🔥 같은 태그가 여러 그룹/카테고리에 중복 정의된 경우,
                        // 나중 항목에 카운트/설명이 없다고 해서 이전에 찾은 값을 null로
                        // 덮어쓰지 않도록 병합(merge) 방식으로 저장한다.
                        if (cleanDesc || !(tag in tagMap)) {
                            tagMap[tag] = cleanDesc;
                        }
                        if (!(tag in tagColorMap)) {
                            tagColorMap[tag] = group.color || "#5a3a1a";
                        }
                        if (count !== null || !(tag in tagCountMap)) {
                            tagCountMap[tag] = count;
                        }
                    });
                });
            });

            // 🔥 확인용 디버그 로그: 콘솔에서 F12 → Console 탭에서 확인
            // "1girl" 카운트가 null로 나오면 YAML 원본 줄 자체에 문제가 있는 것
            console.log("[TagNode] 1girl 파싱 결과:", {
                tagMap_1girl: tagMap["1girl"],
                tagCountMap_1girl: tagCountMap["1girl"]
            });

            // 🔥 tagMap이 다 채워진 시점에 마침표 포함 태그 보호용 정규식 생성
            buildPeriodProtection();

            let searchIndex = [];

            data.forEach(cat => {
                if (!cat.groups) return;

                cat.groups.forEach(group => {
                    if (!group.tags) return;

                    Object.entries(group.tags).forEach(([tag, desc]) => {

                        desc = String(desc ?? "").trim();
                        const cleanDesc = desc.replace(/\s*\[[^\[\]]*\]\s*$/, "");

                        searchIndex.push({
                            category: cat.name,
                            group: group.name,
                            tag,
                            desc: cleanDesc,
                            color: group.color || "#5a3a1a"
                        });
                    });
                });
            });

            function createItem(text, onClick) {
                const div = document.createElement("div");
                div.innerText = text;

                Object.assign(div.style, {
                    padding: "4px",
                    cursor: "pointer",
                    borderBottom: "1px solid #444"
                });

                div.onclick = onClick;
                return div;
            }

            function renderCategories() {
                categoryDiv.innerHTML = "";
                data.forEach(cat => {
                    categoryDiv.appendChild(
                        createItem(cat.name, () => renderGroups(cat))
                    );
                });
            }

            function renderGroups(category) {
                groupDiv.innerHTML = "";
                tagDiv.innerHTML = "";

                category.groups.forEach(group => {
                    const item = createItem(group.name, () => {
                        currentGroup = group;
                        renderTags(group);
                    });

                    // 🔥 스와치 대신 리스트 칸 자체를 그룹 색상으로 채움
                            item.style.background = group.color || "#5a3a1a";

                    // 🔥 우클릭 → 색상 변경 메뉴
                    item.addEventListener("contextmenu", (e) => {
                        showGroupColorMenu(e, category, group);
                    });

                    groupDiv.appendChild(item);
                });
            }

            const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif"];

            // 🔥 이미지 하나가 실제로 존재하는지(로드되는지) 확인
            function tryLoadImage(src) {
                return new Promise((resolve, reject) => {
                    const img = new Image();
                    img.onload = () => resolve(src);
                    img.onerror = () => reject();
                    img.src = src;
                });
            }
            // 🔥 여러 확장자를 순서대로 시도해서 처음 성공하는 것을 반환. 다 실패하면 null
            async function tryLoadImageAnyExt(baseUrl) {
                for (const ext of IMAGE_EXTENSIONS) {
                    try {
                        const src = await tryLoadImage(`${baseUrl}.${ext}?v=${Date.now()}`);
                        return src;
                    } catch (e) {
                        // 다음 확장자 시도
                    }
                }
                return null;
            }
            async function getTagImages(tag) {
                if (tagImageCache.has(tag)) return tagImageCache.get(tag);

                if (!imageManifestLoaded) {
                    await loadImageManifest();
                }

                const files = imageManifest[tag];

                if (!files || files.length === 0) {
                    tagImageCache.set(tag, []);
                    return [];
                }

                // 🔥 캐시버스터 추가 - 새로고침마다 값이 바뀌므로 브라우저가 항상 새로 요청함
                const results = files.map(fn => `${IMAGE_BASE_URL}${fn}?v=${manifestVersion}`);
                tagImageCache.set(tag, results);
                return results;
            }

            async function showImagePreview(tag, x, y) {
                const token = ++previewToken;

                imagePreviewDiv.innerHTML = "";
                imagePreviewDiv.style.display = "none";

                const images = await getTagImages(tag);

                if (token !== previewToken) return; // 그 사이 다른 태그로 마우스가 이동했으면 무시
                if (images.length === 0) return;    // 이미지가 아예 없으면 표시 안 함

                images.forEach(src => {
                    const img = document.createElement("img");
                    img.src = src;

                    Object.assign(img.style, {
                        maxWidth: "150px",
                        maxHeight: "150px",
                        borderRadius: "4px",
                        objectFit: "cover"
                    });

                    imagePreviewDiv.appendChild(img);
                });

                imagePreviewDiv.style.display = "flex";
                positionImagePreview(x, y);
            }

            function positionImagePreview(x, y) {
                imagePreviewDiv.style.left = (x + 16) + "px";
                imagePreviewDiv.style.top = (y + 16) + "px";

                requestAnimationFrame(() => {
                    const rect = imagePreviewDiv.getBoundingClientRect();
                    if (rect.right > window.innerWidth) {
                        imagePreviewDiv.style.left = Math.max(0, x - rect.width - 16) + "px";
                    }
                    if (rect.bottom > window.innerHeight) {
                        imagePreviewDiv.style.top = Math.max(0, y - rect.height - 16) + "px";
                    }
                });
            }

            function hideImagePreview() {
                previewToken++;
                imagePreviewDiv.style.display = "none";
            }

            // 🔥 태그 리스트 항목(el)에 마우스 호버 시 이미지 프리뷰가 뜨도록 연결
            function attachImagePreview(el, tag) {
                el.addEventListener("mouseenter", (e) => {
                    showImagePreview(tag, e.clientX, e.clientY);
                });

                el.addEventListener("mousemove", (e) => {
                    positionImagePreview(e.clientX, e.clientY);
                });

                el.addEventListener("mouseleave", () => {
                    hideImagePreview();
                });
            }

            function renderTags(group) {
                tagDiv.innerHTML = "";

                if (!group || !group.tags) return;

                Object.entries(group.tags || {}).forEach(([tag, desc]) => {

                    desc = String(desc ?? "");

                    const div = document.createElement("div");

                    div.innerHTML = `
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <span><b>${tag}</b></span>
                            <span style="font-size:11px; opacity:0.7;">
                                ${tagCountMap[tag] || ""}
                            </span>
                        </div>
                        <small>${desc.replace(/\s*\[[^\[\]]*\]\s*$/, "") || "&nbsp;"}</small>
                    `;

                    Object.assign(div.style, {
                        padding: "6px",
                        marginBottom: "4px",
                        borderRadius: "6px",
                        background: group.color || "#5a3a1a",
                        cursor: "pointer"
                    });

                    if (selectedTags.some(t => t.clean === tag)) {
                        div.style.outline = "2px solid #fff";
                    }

                    div.onclick = () => {
                        saveHistory();

                        if (!selectedTags.some(t => t.clean === tag)) {
                            selectedTags.push({
                                raw: tag,
                                clean: tag,
                                isGroup: false
                            });
                        } else {
                            selectedTags = selectedTags.filter(t => t.clean !== tag);
                        }

                        updateText();
                        renderSelected();
                        renderTags(group);
                    };

                    attachImagePreview(div, tag);

                    tagDiv.appendChild(div);
                });
            }

            //자동완성기능
            let allTags = [];

            data.forEach(cat => {
                if (!cat.groups) return;

                cat.groups.forEach(group => {
                    if (!group || !group.tags) return;

                    Object.entries(group.tags).forEach(([tag, desc], index) => {
                        desc = String(desc ?? "").trim();
                        const match = desc.match(/\[([^\[\]]*)\]\s*$/);

                        let count = 0;
                        if (match) {
                            const raw = match[1].trim().toLowerCase();
                            if (raw.includes("k")) {
                                count = parseFloat(raw) * 1000;
                            } else if (raw.includes("m")) {
                                count = parseFloat(raw) * 1000000;
                            } else {
                                count = parseFloat(raw) || 0;
                            }
                        }

                        allTags.push({
                            tag,
                            count,
                            order: allTags.length // YAML 순서 유지용
                        });
                    });
                });
            });

            // 🔥 정렬: count 우선 → 없으면 YAML 순서
            allTags.sort((a, b) => {
                if (a.count && b.count) return b.count - a.count;
                if (a.count) return -1;
                if (b.count) return 1;
                return a.order - b.order;
            });
            // =========================
            // 초기화
            // =========================
            renderCategories();

            // =========================
            // wrapper
            // =========================
            const wrapper = document.createElement("div");

            Object.assign(wrapper.style, {
                display: "flex",
                flexDirection: "column",
                gap: "4px",
                height: "100%",
                position: "relative"
            });

            wrapper.append(
                textarea,
                selectedDiv,
                searchInput,
                mainArea
            );

            //자동완성박스
            const autocompleteDiv = document.createElement("div");

            Object.assign(autocompleteDiv.style, {
                position: "absolute",
                background: "#2a2a2a",
                border: "1px solid #555",
                borderRadius: "6px",
                maxHeight: "200px",
                overflowY: "auto",
                width: "fit-content",  
                minWidth: "120px",      
                zIndex: "999",
                display: "none"
            });        

            wrapper.appendChild(autocompleteDiv);
            // 🔥 이미지 프리뷰 박스 (뷰포트 기준 fixed, body에 직접 붙여서 overflow:hidden에 안 잘리게)
            const imagePreviewDiv = document.createElement("div");

            Object.assign(imagePreviewDiv.style, {
                position: "fixed",
                zIndex: "10001",
                background: "#111",
                border: "1px solid #555",
                borderRadius: "6px",
                padding: "6px",
                display: "none",
                pointerEvents: "none", // 마우스 이벤트 방해 안 하도록
                maxWidth: "340px",
                gap: "4px",
                flexWrap: "wrap",
                boxShadow: "0 4px 12px rgba(0,0,0,0.5)"
            });

            document.body.appendChild(imagePreviewDiv);

            // 🔥 먼저 DOM 붙임
            const widget = node.addDOMWidget("ui", "custom", wrapper);

            // 🔥 그 다음에 sync (핵심)
            requestAnimationFrame(() => {
                syncFromWidget();
                saveHistory();
            });

            node.onResize = function () {
                wrapper.style.height = (node.size[1] - 50) + "px";
            };

            widget.computeSize = () => [300, 300];
        };
    }
});