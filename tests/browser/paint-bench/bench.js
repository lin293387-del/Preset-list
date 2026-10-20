/**
 * Builds the chat surface for the paint bench, then signals readiness.
 *
 * Rows mirror TT's message markup (`div.mes` > `.mesAvatarWrapper` + `.mes_block`
 * > `.mes_text`) so TT's own rules land on them. Text is mixed CJK and Latin,
 * because CJK glyph runs with a blur halo is the layout/paint shape the chat
 * actually has — an empty row would measure nothing.
 */
const ROWS = Number(new URLSearchParams(location.search).get('rows') ?? 40);

const LATIN = 'The panel keeps its place while the numbers settle, and nothing repaints under the finger. ';
const CJK = '角色在这里说话，文字带着一层模糊的阴影，滚动时每一行都要重新绘制一遍。';

const AVATAR = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">'
    + '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
    + '<stop offset="0" stop-color="#8ab4f8"/><stop offset="1" stop-color="#2b3a4a"/>'
    + '</linearGradient></defs>'
    + '<rect width="96" height="96" fill="url(#g)"/>'
    + '<circle cx="48" cy="38" r="18" fill="#dce6f2"/>'
    + '<rect x="20" y="62" width="56" height="34" rx="16" fill="#dce6f2"/>'
    + '</svg>',
);

const chat = document.getElementById('chat');
const fragment = document.createDocumentFragment();

for (let index = 0; index < ROWS; index += 1) {
    const isUser = index % 3 === 0;

    const row = document.createElement('div');
    row.className = 'mes';
    row.setAttribute('mesid', String(index));
    row.setAttribute('is_user', String(isUser));
    row.setAttribute('ch_name', isUser ? 'You' : 'Benchmark');

    const wrapper = document.createElement('div');
    wrapper.className = 'mesAvatarWrapper';

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    const image = document.createElement('img');
    image.src = AVATAR;
    image.alt = '';
    avatar.append(image);
    wrapper.append(avatar);

    const block = document.createElement('div');
    block.className = 'mes_block';

    const header = document.createElement('div');
    header.className = 'mes_header';
    const time = document.createElement('div');
    time.className = 'mes_timer';
    time.textContent = `1${String(index).padStart(3, '0')}`;
    header.append(time);

    const text = document.createElement('div');
    text.className = 'mes_text';
    text.textContent = `${CJK}${CJK}${LATIN.repeat(2)}${index}`;

    block.append(header, text);
    row.append(wrapper, block);
    fragment.append(row);
}

chat.append(fragment);
chat.scrollTop = 0;

/**
 * Scrolls to the bottom in `steps` frames and reports the frame interval of each
 * one. Driving `scrollTop` by hand (instead of a fling) keeps the measurement
 * about paint/raster — the cost a backdrop blur adds to every scrolled frame.
 *
 * @param {number} steps
 * @returns {Promise<{frames: number[], scrolled: number}>}
 */
window.__benchScroll = async steps => {
    const frames = [];
    const span = chat.scrollHeight - chat.clientHeight;
    let last = performance.now();

    for (let step = 1; step <= steps; step += 1) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const now = performance.now();
        frames.push(now - last);
        last = now;
        chat.scrollTop = Math.round((span * step) / steps);
    }

    return { frames, scrolled: chat.scrollTop };
};

/** Applies a stylesheet the way an extension's injected CSS would arrive. */
window.__benchInject = css => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    return document.styleSheets.length;
};

window.__benchReady = true;
