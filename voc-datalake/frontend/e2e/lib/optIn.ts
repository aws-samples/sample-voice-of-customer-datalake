/** Is the opt-in env switch `name` on (exactly `'1'`)? Used to gate production steps that spend money (Bedrock). */
export const optIn = (name: string): boolean => process.env[name] === '1'
