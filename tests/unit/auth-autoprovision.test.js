import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { login, getCurrentUser, changeOwnPassword } from '@/services/auth'

const TEST_USERS = [
  { id: 'USR-3001', name: 'موظف تجريبي', email: 'emp@store.com', role: 'employee', passwordHash: 'dummyhash', passwordSalt: 'dummysalt' }
]

describe('services/auth — auto-provisioning & password tolerance (V3.67)', () => {
  beforeEach(() => {
    sessionStorage.clear()
    window.getUsers = () => TEST_USERS.map(u => ({ ...u }))
  })

  afterEach(() => {
    delete window.getUsers
    delete window.auth
    delete window._authUser
    sessionStorage.clear()
  })

  it('تسامح كلمة المرور إذا كانت تجزئة PBKDF2 مطابقة لكن Firebase Auth غير متزامن', async () => {
    window.auth = {
      currentUser: null,
      signInWithEmailAndPassword: vi.fn(async () => {
        const err = new Error('Firebase: Error (auth/wrong-password).')
        err.code = 'auth/wrong-password'
        throw err
      }),
    }
    window._authUser = null

    // Mock verifyPasswordHash in auth by using the real user whose hash matches our input
    // In our test, if verifyPasswordHash matches (or if we mock verifyPasswordHash)
    // login should not throw error if hash is verified!
  })
})
