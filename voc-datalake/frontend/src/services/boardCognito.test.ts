/**
 * The board pool's Cognito plumbing: refusals mapped to the reason shown, and the throwaway password.
 */
import { describe, it, expect } from 'vitest'
import { BoardAuthError, CognitoRefusal, randomBoardPassword, toBoardAuthError } from './boardCognito'

describe('Cognito error mapping', () => {
  it.each([
    [{ __type: 'com.amazonaws#LimitExceededException' }, 'too_many'],
    [{ __type: 'CodeMismatchException' }, 'wrong_code'],
    [{ __type: 'ExpiredCodeException' }, 'expired'],
    [{ __type: 'UserLambdaValidationException', message: 'PreSignUp failed with error domain_not_allowed.' }, 'domain_not_allowed'],
    [{ __type: 'UserLambdaValidationException', message: 'something else' }, 'unknown'],
    [{ __type: 'SomethingNew' }, 'unknown'],
    ['not json', 'unknown'],
  ])('maps %j to %s', (body, expected) => {
    expect(toBoardAuthError(new CognitoRefusal(body)).code).toBe(expected)
  })

  it('keeps a board error as is and maps anything else to unknown', () => {
    const own = new BoardAuthError('no_session')
    expect([toBoardAuthError(own), toBoardAuthError(new TypeError('offline')).code]).toStrictEqual([own, 'unknown'])
  })

  it('reads the exception name without its namespace', () => {
    expect(new CognitoRefusal({ __type: 'com.amazonaws#UsernameExistsException' }).type).toBe('UsernameExistsException')
  })
})

describe('the throwaway sign-up password', () => {
  it('is 32 characters with an upper-case letter, a lower-case letter, a digit and a symbol', () => {
    const passwords = Array.from({ length: 50 }, () => randomBoardPassword())
    const classes = [/[A-Z]/, /[a-z]/, /\d/, /[!@#$%^&*()\-_=+[\]{}]/]

    expect(passwords.every((password) => password.length === 32)).toBe(true)
    expect(passwords.every((password) => classes.every((pattern) => pattern.test(password)))).toBe(true)
  })

  it('differs between sign-ups', () => {
    expect(randomBoardPassword()).not.toBe(randomBoardPassword())
  })
})
