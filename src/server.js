import express from 'express';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuid } from 'uuid';
import sharp from 'sharp';
import { promisify } from 'util';
import stream from 'stream';
import { execFile } from 'child_process';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json({ limit: '10mb' }));

const pipeline = promisify(stream.pipeline);
const execFileAsync = promisify(execFile);
const DEFAULT_BUCKET = process.env.CONVERSION_DEFAULT_BUCKET || 'editions';
const SERVICE_SECRET = process.env.CONVERSION_SERVICE_SECRET || '';
const PORT = Number(process.env.PORT || 3000);

const VARIANTS = [
  { key: 'low', width: 900, quality: 72 },
  { key: 'medium', width: 1400, quality: 80 },
  { key: 'high', width: 2400, quality: 90 },
];

const THUMBNAIL_VARIANT = { key: 'thumbnail', width: 360, quality: 60 };

const ensureTrailingSlash = (value) => (value.endsWith('/') ? value : `${value}/`);

const padNumber = (value, size = 3) => String(value).padStart(size, '0');

const buildStoragePath = (editionId, variant, pageNumber) =>
  `${editionId}/pages/${variant}/${padNumber(pageNumber)}.webp`;

const createTempDir = async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pdf-conversion-'));
  return dir;
};

const removeDirSafe = async (dirPath) => {
  if (!dirPath) return;
  try {
    await fsp.rm(dirPath, { recursive: true, force: true });
  } catch (error) {
    console.warn('Failed to cleanup temp directory', error);
  }
};

const convertPdfToPng = async (pdfPath, outputDir, dpi = 300) => {
  const prefix = path.join(outputDir, 'page');
  try {
    await execFileAsync('pdftoppm', ['-png', '-r', String(dpi), pdfPath, prefix]);
  } catch (error) {
    throw new Error(`pdftoppm failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const files = await fsp.readdir(outputDir);
  return files
    .filter((file) => file.startsWith('page') && file.endsWith('.png'))
    .sort((a, b) => {
      const pageA = parseInt(a.match(/(\d+)\.png$/)?.[1] ?? '0', 10);
      const pageB = parseInt(b.match(/(\d+)\.png$/)?.[1] ?? '0', 10);
      return pageA - pageB;
    })
    .map((file) => path.join(outputDir, file));
};

const downloadPdf = async (pdfUrl, destinationPath) => {
  const response = await axios.get(pdfUrl, { responseType: 'stream' });
  await pipeline(response.data, fs.createWriteStream(destinationPath));
};

const cloneSharpForVariant = async (input, metadata, config) => {
  const maxWidth = metadata.width ?? config.width;
  const targetWidth = Math.min(config.width, maxWidth);

  let transformer = sharp(input);
  if (config.height) {
    transformer = transformer.resize({
      width: targetWidth,
      height: config.height,
      fit: 'cover',
    });
  } else {
    transformer = transformer.resize({ width: targetWidth, withoutEnlargement: true });
  }

  return transformer.webp({ quality: config.quality }).toBuffer();
};

const uploadBuffer = async (supabase, bucket, storagePath, buffer) => {
  const { error } = await supabase.storage
    .from(bucket)
    .upload(storagePath, buffer, {
      contentType: 'image/webp',
      upsert: true,
    });

  if (error) {
    throw new Error(`Failed to upload ${storagePath}: ${error.message}`);
  }
};

const getPublicUrl = (supabase, bucket, storagePath) =>
  supabase.storage.from(bucket).getPublicUrl(storagePath).data.publicUrl;

app.post('/convert', async (req, res) => {
  try {
    const requestSecret = req.headers['x-api-key'] || '';
    if (SERVICE_SECRET && requestSecret !== SERVICE_SECRET) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const {
      editionId,
      pdfUrl,
      supabaseUrl,
      supabaseKey,
      bucket = DEFAULT_BUCKET,
      variants = VARIANTS,
      thumbnail = THUMBNAIL_VARIANT,
    } = req.body ?? {};

    if (!editionId || !pdfUrl || !supabaseUrl || !supabaseKey) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters (editionId, pdfUrl, supabaseUrl, supabaseKey)',
      });
    }

    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const tempRoot = await createTempDir();
    const pdfPath = path.join(tempRoot, `${uuid()}.pdf`);
    const pngDir = path.join(tempRoot, 'png');
    await fsp.mkdir(pngDir, { recursive: true });

    await downloadPdf(pdfUrl, pdfPath);

    const pngPages = await convertPdfToPng(pdfPath, pngDir);
    if (pngPages.length === 0) {
      throw new Error('No pages produced during PDF conversion');
    }

    const manifestPages = [];
    const uploads = [];

    const bucketBaseUrl = ensureTrailingSlash(`${supabaseUrl}/storage/v1/object/public/${bucket}`);

    for (let index = 0; index < pngPages.length; index += 1) {
      const pageNumber = index + 1;
      const pngPath = pngPages[index];
      const pngBuffer = await fsp.readFile(pngPath);
      const image = sharp(pngBuffer);
      const metadata = await image.metadata();

      const variantUploads = {};

      for (const variant of variants) {
        const buffer = await cloneSharpForVariant(pngBuffer, metadata, variant);
        const storagePath = buildStoragePath(editionId, variant.key, pageNumber);
        await uploadBuffer(supabase, bucket, storagePath, buffer);
        const publicUrl = getPublicUrl(supabase, bucket, storagePath);

        variantUploads[variant.key] = {
          path: storagePath,
          publicUrl,
        };
        uploads.push(storagePath);
      }

      const thumbBuffer = await cloneSharpForVariant(pngBuffer, metadata, thumbnail);
      const thumbStoragePath = `${editionId}/pages/${thumbnail.key}/${padNumber(pageNumber)}.webp`;
      await uploadBuffer(supabase, bucket, thumbStoragePath, thumbBuffer);

      const thumbnailPublicUrl = getPublicUrl(supabase, bucket, thumbStoragePath);
      variantUploads[thumbnail.key] = {
        path: thumbStoragePath,
        publicUrl: thumbnailPublicUrl,
      };
      uploads.push(thumbStoragePath);

      manifestPages.push({
        pageNumber,
        width: metadata.width ?? null,
        height: metadata.height ?? null,
        assets: variantUploads,
      });
    }

    const manifest = {
      edition: {
        id: editionId,
        totalPages: manifestPages.length,
      },
      assetsBaseUrl: bucketBaseUrl,
      bucket,
      generatedAt: new Date().toISOString(),
      pages: manifestPages.map((page) => ({
        pageNumber: page.pageNumber,
        width: page.width,
        height: page.height,
        lowResImagePath: page.assets.low?.path ?? page.assets.medium?.path,
        mediumImagePath: page.assets.medium?.path ?? null,
        highResImagePath: page.assets.high?.path ?? null,
        thumbnailPath: page.assets[thumbnail.key]?.path ?? page.assets.low?.path ?? null,
      })),
    };

    const manifestPath = `${editionId}/manifest.json`;
    await uploadBuffer(supabase, bucket, manifestPath, Buffer.from(JSON.stringify(manifest, null, 2)));

    await removeDirSafe(tempRoot);

    return res.json({
      success: true,
      editionId,
      bucket,
      manifestPath,
      totalPages: manifest.pages.length,
      pages: manifestPages,
      uploads,
    });
  } catch (error) {
    console.error('[conversion-service] Failed to convert PDF:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.listen(PORT, () => {
  console.log(`PDF conversion service listening on port ${PORT}`);
});

