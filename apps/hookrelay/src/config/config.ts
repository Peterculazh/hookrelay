// env
export const NODE_ENV = process.env.NODE_ENV || 'development';
export const IS_PROD = NODE_ENV === 'production';
export const IS_DEV = NODE_ENV === 'development';

// database
export const DB_USER = process.env.DB_USER || 'dbuser';
export const DB_PASSWORD = process.env.DB_PASSWORD || 'dbpassword';
export const DB_PORT = process.env.DB_PORT || 5432;
export const DB_HOST =
  process.env.DB_HOST || (IS_DEV ? 'localhost' : 'postgres');
export const DB_NAME = process.env.DB_NAME || 'db';
export const DB_CONNECTION_STRING = `postgres://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;
export const DB_IDLE_TIMEOUT = process.env.DB_IDLE_TIMEOUT
  ? parseInt(process.env.DB_IDLE_TIMEOUT)
  : 10_000;

export const WEBHOOK_TARGET_URL = process.env.WEBHOOK_TARGET_URL || 'string';
