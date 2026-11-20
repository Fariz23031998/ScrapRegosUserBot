import dotenv from 'dotenv';
import { envPath } from '../src/paths';
import { getRegosState } from '../src/live/session-manager';
import { createHttpRequest } from '../src/live/http-client';
import { searchVcr1Partners } from '../src/sync/vcr1-partners-api';
import { searchVcr1Licenses } from '../src/sync/vcr1-licenses-api';
import { vcr1PartnerFromApiRow, vcr1LicenseFromApiRow } from '../src/live/mappers';

dotenv.config({ path: envPath() });

async function main() {
  const request = createHttpRequest(getRegosState('BUKHARA'));
  const partners = await searchVcr1Partners(request, '998');
  const licenses = await searchVcr1Licenses(request, 'VCR');
  const partner = partners.rows[0] ? vcr1PartnerFromApiRow(partners.rows[0]) : null;
  const license = licenses.rows[0] ? vcr1LicenseFromApiRow(licenses.rows[0]) : null;
  console.log(
    JSON.stringify(
      {
        partnersTotal: partners.total,
        partnerSample: partner,
        licensesTotal: licenses.total,
        licenseSample: license
          ? { id: license.id, serial: license.serial, monthly_fee: license.monthly_fee, status: license.status }
          : null,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
