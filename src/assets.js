// Loads the Blender-rendered sprite atlases listed in assets/manifest.json and prepares tinted variants.
const V = Date.now();   // bust the browser cache so re-rendered sprites show up immediately

function loadImage(file, tries = 3) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => (tries > 1 ? setTimeout(() => loadImage(file, tries - 1).then(resolve, reject), 300) : reject(new Error('Missing image: ' + file)));
    img.src = `assets/${file}?v=${V}`;
  });
}

function tint(img, color) {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0);
  x.globalCompositeOperation = 'source-atop';
  x.fillStyle = color;
  x.fillRect(0, 0, c.width, c.height);
  return c;
}

export async function loadAssets(onProgress) {
  const man = await fetch(`assets/manifest.json?v=${V}`).then(r => r.json());
  const layout = await fetch(`assets/layout.json?v=${V}`).then(r => r.json());
  const entries = [man.ground];
  for (const sec of ['towers', 'creeps', 'props', 'icons', 'portraits', 'ui']) if (man[sec]) entries.push(...Object.values(man[sec]).filter(m => m && m.file));
  const files = [...new Set(entries.map(m => m.file))];
  const images = {};
  let done = 0;
  const queue = [...files];
  const worker = async () => {          // four downloads at a time
    while (queue.length) {
      const f = queue.shift();
      images[f] = await loadImage(f);
      onProgress?.(++done / files.length);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  for (const m of entries) { m.img = images[m.file]; m.sx = m.sx || 0; m.sy = m.sy || 0; }
  const tinted = {};
  for (const m of Object.values(man.creeps)) {
    tinted[m.file] ??= { slow: tint(m.img, 'rgba(80,160,255,0.45)'), hit: tint(m.img, 'rgba(255,255,255,0.55)') };
    m.slowImg = tinted[m.file].slow;
    m.hitImg = tinted[m.file].hit;
  }
  return { man, layout };
}
