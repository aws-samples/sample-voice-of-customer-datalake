/**
 * @fileoverview Spec support for ProtectedRoute: the two-route harness both
 * its suites mount — `/login` as the redirect target and `/protected` wrapped
 * by the guard — so the mocked-store and real-store suites cannot drift on it.
 */
import { render } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import ProtectedRoute from './ProtectedRoute'

/** Mount the guard around a marker child at `/protected`, with `/login` rendering "Login Page". */
export function renderProtected(initialEntries = ['/protected']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route path="/login" element={<div>Login Page</div>} />
        <Route
          path="/protected"
          element={<ProtectedRoute><div>Protected Content</div></ProtectedRoute>}
        />
      </Routes>
    </MemoryRouter>,
  )
}
