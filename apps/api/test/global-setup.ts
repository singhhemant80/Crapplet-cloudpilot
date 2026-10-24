import { resetDatabase } from './helpers';

export default async function setup() {
  await resetDatabase();
}
