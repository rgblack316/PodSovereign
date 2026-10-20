/**
 * Storage providers offered in Site settings, with the fields each needs.
 * The dashboard renders the form from this list, and toClient() turns the
 * saved values into an S3 or Bunny client.
 */
import { BunnyClient } from './bunny.js';
import { S3Client } from './s3.js';

export interface FieldDef {
  key: string;
  label: string;
  type: 'text' | 'select' | 'secret' | 'checkbox' | 'url';
  required?: boolean;
  placeholder?: string;
  hint?: string;
  options?: { value: string; label: string }[];
  /** A select that also accepts a typed value (e.g. a storage region added after this list). */
  allowOther?: boolean;
  default?: string | boolean;
}

export interface ProviderDef {
  id: string;
  name: string;
  /** One or two lines shown under the picker. */
  blurb: string;
  docsUrl: string;
  fields: FieldDef[];
  /** Hint for the public address field. */
  publicUrlHint: string;
  publicUrlPlaceholder: string;
  /** Used with a real account in production. The others are built to each provider's docs but untested. */
  tested: boolean;
}

const opts = (list: [string, string][]) => list.map(([value, label]) => ({ value, label }));

const WASABI_REGIONS = opts([
  ['us-east-1', 'US East 1 (N. Virginia)'], ['us-east-2', 'US East 2 (N. Virginia)'], ['us-central-1', 'US Central 1 (Texas)'],
  ['us-west-1', 'US West 1 (Oregon)'], ['us-west-2', 'US West 2 (San Jose)'], ['ca-central-1', 'CA Central 1 (Toronto)'],
  ['eu-central-1', 'EU Central 1 (Amsterdam)'], ['eu-central-2', 'EU Central 2 (Frankfurt)'], ['eu-west-1', 'EU West 1 (London)'],
  ['eu-west-2', 'EU West 2 (Paris)'], ['eu-west-3', 'EU West 3 (London)'], ['eu-south-1', 'EU South 1 (Milan)'],
  ['ap-northeast-1', 'AP Northeast 1 (Tokyo)'], ['ap-northeast-2', 'AP Northeast 2 (Osaka)'],
  ['ap-southeast-1', 'AP Southeast 1 (Singapore)'], ['ap-southeast-2', 'AP Southeast 2 (Sydney)'],
]);

const SPACES_REGIONS = opts([
  ['nyc3', 'New York (nyc3)'], ['atl1', 'Atlanta (atl1)'], ['ric1', 'Richmond (ric1)'], ['mkc1', 'Kansas City (mkc1)'],
  ['sfo2', 'San Francisco (sfo2)'], ['sfo3', 'San Francisco (sfo3)'], ['tor1', 'Toronto (tor1)'], ['ams3', 'Amsterdam (ams3)'],
  ['fra1', 'Frankfurt (fra1)'], ['lon1', 'London (lon1)'], ['sgp1', 'Singapore (sgp1)'], ['blr1', 'Bangalore (blr1)'],
  ['syd1', 'Sydney (syd1)'],
]);

const BUNNY_REGIONS = opts([
  ['storage.bunnycdn.com', 'Frankfurt, DE'], ['uk.storage.bunnycdn.com', 'London, UK'],
  ['ny.storage.bunnycdn.com', 'New York, US'], ['la.storage.bunnycdn.com', 'Los Angeles, US'],
  ['sg.storage.bunnycdn.com', 'Singapore'], ['se.storage.bunnycdn.com', 'Stockholm, SE'],
  ['br.storage.bunnycdn.com', 'São Paulo, BR'], ['jh.storage.bunnycdn.com', 'Johannesburg, ZA'],
  ['syd.storage.bunnycdn.com', 'Sydney, AU'],
]);

const keyFields = (idLabel: string, secretLabel: string, idHint?: string, secretHint?: string): FieldDef[] => [
  { key: 'accessKeyId', label: idLabel, type: 'text', required: true, hint: idHint },
  { key: 'secret', label: secretLabel, type: 'secret', required: true, hint: secretHint },
];
const bucketField: FieldDef = { key: 'bucket', label: 'Bucket name', type: 'text', required: true };

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'r2',
    tested: true,
    name: 'Cloudflare R2',
    blurb: 'No download (egress) fees. Connect a custom domain to the bucket for public access.',
    docsUrl: 'https://developers.cloudflare.com/r2/get-started/s3/',
    fields: [
      { key: 'accountId', label: 'Account ID', type: 'text', required: true, hint: 'Shown in the R2 S3 API endpoint: https://<account ID>.r2.cloudflarestorage.com' },
      ...keyFields('Access key ID', 'Secret access key', 'From an R2 API token with Object Read & Write permission.', 'Shown once when you create the token.'),
      bucketField,
    ],
    publicUrlHint: 'The custom domain connected to this bucket (Bucket → Settings → Custom Domains). The r2.dev address works for testing but is rate-limited.',
    publicUrlPlaceholder: 'https://media.example.com',
  },
  {
    id: 'b2',
    tested: false,
    name: 'Backblaze B2',
    blurb: 'Low-cost storage. The bucket must be set to Public.',
    docsUrl: 'https://www.backblaze.com/apidocs/introduction-to-the-s3-compatible-api',
    fields: [
      { key: 'endpoint', label: 'S3 endpoint', type: 'text', required: true, placeholder: 's3.us-west-004.backblazeb2.com', hint: 'Shown on the bucket’s details as “Endpoint”.' },
      ...keyFields('Application key ID', 'Application key', 'Create an application key for this bucket (the master key doesn’t work with the S3 API).'),
      bucketField,
    ],
    publicUrlHint: 'The bucket’s friendly URL, e.g. https://f004.backblazeb2.com/file/<bucket>, or a CDN in front of it.',
    publicUrlPlaceholder: 'https://f004.backblazeb2.com/file/my-bucket',
  },
  {
    id: 's3',
    tested: false,
    name: 'Amazon S3',
    blurb: 'Use CloudFront (or a public bucket policy) to make files public.',
    docsUrl: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html',
    fields: [
      { key: 'region', label: 'Region', type: 'text', required: true, placeholder: 'us-east-1' },
      ...keyFields('Access key ID', 'Secret access key', 'An IAM user or role key with s3:PutObject, GetObject, DeleteObject and ListBucket on this bucket.'),
      bucketField,
    ],
    publicUrlHint: 'Your CloudFront address, or https://<bucket>.s3.<region>.amazonaws.com if the bucket is public.',
    publicUrlPlaceholder: 'https://d1234abcd.cloudfront.net',
  },
  {
    id: 'wasabi',
    tested: false,
    name: 'Wasabi',
    blurb: 'Flat-rate storage. Make the bucket public or put a CDN in front.',
    docsUrl: 'https://docs.wasabi.com/docs/what-are-the-service-urls-for-wasabis-different-storage-regions',
    fields: [
      { key: 'region', label: 'Region', type: 'select', required: true, options: WASABI_REGIONS, default: 'us-east-1' },
      ...keyFields('Access key', 'Secret key'),
      bucketField,
      { key: 'publicRead', label: 'Mark each uploaded file public (public-read)', type: 'checkbox', default: false, hint: 'Only needed if the bucket itself isn’t public.' },
    ],
    publicUrlHint: 'https://s3.<region>.wasabisys.com/<bucket> for a public bucket, or your CDN address.',
    publicUrlPlaceholder: 'https://s3.us-east-1.wasabisys.com/my-bucket',
  },
  {
    id: 'spaces',
    tested: false,
    name: 'DigitalOcean Spaces',
    blurb: 'Includes a built-in CDN. Files are private by default, so each upload is marked public.',
    docsUrl: 'https://docs.digitalocean.com/products/spaces/reference/aws-sdks/',
    fields: [
      { key: 'region', label: 'Region', type: 'select', required: true, options: SPACES_REGIONS, default: 'nyc3' },
      ...keyFields('Access key', 'Secret key', 'Create a Spaces access key with read/write access to this bucket.'),
      bucketField,
    ],
    publicUrlHint: 'The Spaces CDN address, https://<bucket>.<region>.cdn.digitaloceanspaces.com (or your custom CDN domain).',
    publicUrlPlaceholder: 'https://my-bucket.nyc3.cdn.digitaloceanspaces.com',
  },
  {
    id: 'bunny',
    tested: false,
    name: 'Bunny Storage',
    blurb: 'Storage zone plus a pull zone (CDN). Uses Bunny’s own API.',
    docsUrl: 'https://docs.bunny.net/reference/storage-api',
    fields: [
      { key: 'zone', label: 'Storage zone name', type: 'text', required: true },
      { key: 'secret', label: 'Storage zone password', type: 'secret', required: true, hint: 'Storage zone → FTP & API Access → Password. Not your account API key.' },
      { key: 'hostname', label: 'Main storage region', type: 'select', required: true, options: BUNNY_REGIONS, allowOther: true, default: 'storage.bunnycdn.com', hint: 'The storage endpoint for the zone’s main region (shown on the zone’s FTP & API Access page).' },
    ],
    publicUrlHint: 'The pull zone connected to this storage zone, e.g. https://<pull zone>.b-cdn.net, or its custom hostname.',
    publicUrlPlaceholder: 'https://my-podcasts.b-cdn.net',
  },
  {
    id: 'other',
    tested: false,
    name: 'Other S3-compatible',
    blurb: 'MinIO, Linode/Akamai, Scaleway, IDrive e2, and others that speak the S3 API.',
    docsUrl: 'https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-authenticating-requests.html',
    fields: [
      { key: 'endpoint', label: 'S3 endpoint', type: 'text', required: true, placeholder: 'https://s3.example.com' },
      { key: 'region', label: 'Region', type: 'text', required: true, placeholder: 'us-east-1', default: 'us-east-1' },
      ...keyFields('Access key ID', 'Secret access key'),
      bucketField,
      { key: 'pathStyle', label: 'Use path-style URLs (endpoint/bucket/key)', type: 'checkbox', default: true },
      { key: 'publicRead', label: 'Mark each uploaded file public (public-read)', type: 'checkbox', default: false },
    ],
    publicUrlHint: 'The address files are publicly served from.',
    publicUrlPlaceholder: 'https://cdn.example.com',
  },
];

export const providerById = (id: string) => PROVIDERS.find((p) => p.id === id);

export type StorageSettings = Record<string, string | boolean>;

export class StorageConfigError extends Error {}

/** Check required fields and normalise. Throws StorageConfigError. */
export function validateSettings(providerId: string, settings: StorageSettings, secret: string | null): StorageSettings {
  const p = providerById(providerId);
  if (!p) throw new StorageConfigError('Choose a storage provider');
  const out: StorageSettings = {};
  for (const f of p.fields) {
    if (f.key === 'secret') {
      if (!secret) throw new StorageConfigError(`${f.label} is required`);
      continue;
    }
    let v = settings[f.key] ?? f.default;
    if (f.type === 'checkbox') {
      out[f.key] = v === true;
      continue;
    }
    v = typeof v === 'string' ? v.trim() : '';
    if (!v && f.required) throw new StorageConfigError(`${f.label} is required`);
    if (f.options && v && !f.options.some((o) => o.value === v)) {
      const hostLike = /^(https?:\/\/)?[a-z0-9.-]+(:\d+)?\/?$/i.test(v);
      if (!f.allowOther || !hostLike) throw new StorageConfigError(`Choose a ${f.label.toLowerCase()} from the list`);
    }
    if (f.key === 'bucket' && v && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/i.test(v)) throw new StorageConfigError('That bucket name isn’t valid');
    if (f.key === 'accountId' && v && !/^[0-9a-f]{32}$/i.test(v)) throw new StorageConfigError('The Account ID is 32 letters and numbers (0-9, a-f)');
    out[f.key] = v;
  }
  const pub = typeof settings.publicUrl === 'string' ? settings.publicUrl.trim().replace(/\/+$/, '') : '';
  if (!pub) throw new StorageConfigError('Public address is required, so podcast apps can download the files');
  try {
    const u = new URL(pub);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
    if (u.search || u.hash) throw new Error();
  } catch {
    throw new StorageConfigError('Public address must be a full https:// address, without ? or #');
  }
  out.publicUrl = pub;
  return out;
}

export type RemoteClient = S3Client | BunnyClient;

const withScheme = (s: string) => (/^https?:\/\//i.test(s) ? s : `https://${s}`);

/** Build a client from validated settings. */
export function toClient(providerId: string, s: StorageSettings, secret: string): RemoteClient {
  const str = (k: string) => String(s[k] ?? '');
  switch (providerId) {
    case 'r2':
      return new S3Client({ endpoint: `https://${str('accountId')}.r2.cloudflarestorage.com`, region: 'auto', bucket: str('bucket'), accessKeyId: str('accessKeyId'), secretAccessKey: secret, pathStyle: true });
    case 'b2': {
      const endpoint = withScheme(str('endpoint'));
      const region = /s3\.([a-z0-9-]+)\.backblazeb2\.com/i.exec(endpoint)?.[1] ?? 'us-west-004';
      return new S3Client({ endpoint, region, bucket: str('bucket'), accessKeyId: str('accessKeyId'), secretAccessKey: secret, pathStyle: true });
    }
    case 's3':
      return new S3Client({ endpoint: `https://s3.${str('region')}.amazonaws.com`, region: str('region'), bucket: str('bucket'), accessKeyId: str('accessKeyId'), secretAccessKey: secret, pathStyle: false });
    case 'wasabi':
      return new S3Client({ endpoint: `https://s3.${str('region')}.wasabisys.com`, region: str('region'), bucket: str('bucket'), accessKeyId: str('accessKeyId'), secretAccessKey: secret, pathStyle: true, acl: s.publicRead ? 'public-read' : null });
    case 'spaces':
      return new S3Client({ endpoint: `https://${str('region')}.digitaloceanspaces.com`, region: str('region'), bucket: str('bucket'), accessKeyId: str('accessKeyId'), secretAccessKey: secret, pathStyle: false, acl: 'public-read' });
    case 'bunny':
      return new BunnyClient({ hostname: str('hostname'), zone: str('zone'), password: secret });
    case 'other':
      return new S3Client({ endpoint: withScheme(str('endpoint')), region: str('region') || 'us-east-1', bucket: str('bucket'), accessKeyId: str('accessKeyId'), secretAccessKey: secret, pathStyle: s.pathStyle !== false, acl: s.publicRead ? 'public-read' : null });
    default:
      throw new StorageConfigError(`Unknown provider ${providerId}`);
  }
}
