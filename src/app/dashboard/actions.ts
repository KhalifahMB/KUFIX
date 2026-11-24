'use server';

import { db } from '@/db';
import { users, providers, bookings, quoteRequests, quotes, reviews, supportRequests, serviceCategories } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { checkPassword, hashPassword, requireFormUser } from '@/lib/auth';
import { isDemoUser, demoAccountByEmail } from '@/lib/demo';
import { getCategories } from '@/lib/marketplace';

const val = (data: FormData, key: string) => String(data.get(key) || '').trim();
const validId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
function tokenFrom(data: FormData) { return String(data.get('t') || ''); }
function done(data: FormData, tab: string, message: string, kind: 'success' | 'error' = 'success'): never { revalidatePath('/dashboard'); const t = tokenFrom(data); redirect(`/dashboard?tab=${tab}${t ? `&t=${encodeURIComponent(t)}` : ''}&${kind}=${encodeURIComponent(message)}`); }
function rejectDemo(user: { id: string }, data: FormData) { if (isDemoUser(user)) redirect(`/dashboard?notice=demo${tokenFrom(data) ? `&t=${encodeURIComponent(tokenFrom(data))}` : ''}`); }

export async function saveProfileAction(data: FormData) {
  const user = await requireFormUser(data); rejectDemo(user, data);
  const name = val(data, 'name'), email = val(data, 'email').toLowerCase(), phone = val(data, 'phone'), location = val(data, 'location');
  if (!name || name.length > 180 || !email.includes('@') || email.length > 255 || !phone || phone.length > 30 || !location || location.length > 180 || demoAccountByEmail(email)) done(data, 'settings', 'Please provide valid profile details.', 'error');
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing && existing.id !== user.id) done(data, 'settings', 'This email is already in use.', 'error');
  const category = val(data, 'category');
  const categories = await getCategories();
  const [existingProvider] = user.role === 'provider' ? await db.select().from(providers).where(eq(providers.userId, user.id)).limit(1) : [];
  if (user.role === 'provider' && !categories.some(c => c.name === category) && existingProvider?.category !== category) done(data, 'settings', 'Please select a valid service category.', 'error');
  await db.update(users).set({ name, email, phone, location }).where(eq(users.id, user.id));
  if (user.role === 'provider') {
    const profile = { name, location, category, area: val(data, 'area') || location, bio: val(data, 'bio'), experience: val(data, 'experience') || null, available: data.get('available') === 'on' };
    if (existingProvider) await db.update(providers).set(profile).where(eq(providers.userId, user.id));
    else await db.insert(providers).values({ ...profile, userId: user.id });
  }
  done(data, 'settings', 'Your profile has been updated.');
}

export async function changePasswordAction(data: FormData) {
  const user = await requireFormUser(data); rejectDemo(user, data);
  const current = val(data, 'currentPassword'), password = val(data, 'newPassword'), confirm = val(data, 'confirmPassword');
  if (!checkPassword(current, user.passwordHash)) done(data, 'settings', 'Your current password is incorrect.', 'error');
  if (password.length < 8 || password.length > 512 || password !== confirm) done(data, 'settings', 'New passwords must match and contain at least 8 characters.', 'error');
  await db.update(users).set({ passwordHash: hashPassword(password) }).where(eq(users.id, user.id));
  done(data, 'settings', 'Your password has been changed.');
}

export async function rescheduleAction(data: FormData) {
  const user = await requireFormUser(data, 'provider'); rejectDemo(user, data);
  const id = val(data, 'id'), date = val(data, 'date'), time = val(data, 'time');
  if (!validId(id) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) done(data, 'bookings', 'Please provide a valid date and time.', 'error');
  const [provider] = await db.select().from(providers).where(eq(providers.userId, user.id)).limit(1);
  const [booking] = await db.select().from(bookings).where(eq(bookings.id, id)).limit(1);
  if (!provider || !booking || booking.providerId !== provider.id || !['Pending', 'Accepted', 'Rescheduled'].includes(booking.status)) done(data, 'bookings', 'This request cannot be rescheduled.', 'error');
  await db.update(bookings).set({ date, time, status: 'Rescheduled' }).where(eq(bookings.id, id));
  done(data, 'bookings', 'A new date and time has been suggested.');
}

export async function cancelQuoteRequestAction(data: FormData) {
  const user = await requireFormUser(data, 'customer'); rejectDemo(user, data); const id = val(data, 'id');
  if (!validId(id)) done(data, 'quotes', 'Request not found.', 'error');
  const [request] = await db.select().from(quoteRequests).where(and(eq(quoteRequests.id, id), eq(quoteRequests.customerId, user.id))).limit(1);
  if (!request || request.status !== 'Open') done(data, 'quotes', 'Only open requests can be cancelled.', 'error');
  await db.update(quoteRequests).set({ status: 'Cancelled' }).where(eq(quoteRequests.id, id));
  done(data, 'quotes', 'Quote request cancelled.');
}

export async function dashboardSupportAction(data: FormData) {
  const user = await requireFormUser(data); rejectDemo(user, data); const subject = val(data, 'subject'), message = val(data, 'message');
  if (!subject || subject.length > 180 || !message) done(data, 'support', 'Please provide a subject and message.', 'error');
  await db.insert(supportRequests).values({ userId: user.id, name: user.name, email: user.email, phone: user.phone, subject, message });
  done(data, 'support', 'Your support request has been submitted.');
}

export async function adminUserStatusAction(data: FormData) {
  const user = await requireFormUser(data, 'admin'); rejectDemo(user, data); const id = val(data, 'id'), suspend = val(data, 'suspend') === 'true';
  if (!validId(id) || id === user.id) done(data, 'users', 'You cannot change this account.', 'error');
  await db.update(users).set({ isSuspended: suspend }).where(eq(users.id, id));
  done(data, 'users', suspend ? 'Account suspended.' : 'Account reactivated.');
}

export async function adminVerificationAction(data: FormData) {
  const user = await requireFormUser(data, 'admin'); rejectDemo(user, data); const id = val(data, 'id'), status = val(data, 'verification');
  const allowed = ['Not verified', 'Phone verified', 'Identity checked', 'Business/profile reviewed', 'Professional credentials checked'];
  if (!validId(id) || !allowed.includes(status) || (status !== 'Not verified' && data.get('confirmed') !== 'on')) done(data, 'verification', 'Confirm the check before changing the verification label.', 'error');
  const [provider] = await db.select().from(providers).where(eq(providers.id, id)).limit(1);
  if (!provider || provider.isDemo) done(data, 'verification', 'Sample profiles cannot be verified.', 'error');
  await db.update(providers).set({ verification: status }).where(eq(providers.id, id));
  revalidatePath('/professionals'); done(data, 'verification', 'Verification label updated.');
}

export async function adminReviewAction(data: FormData) {
  const user = await requireFormUser(data, 'admin'); rejectDemo(user, data); const id = val(data, 'id');
  if (!validId(id)) done(data, 'reviews', 'Review not found.', 'error');
  await db.update(reviews).set({ hidden: val(data, 'hidden') === 'true' }).where(eq(reviews.id, id));
  revalidatePath('/professionals'); done(data, 'reviews', 'Review visibility updated.');
}

export async function adminSupportAction(data: FormData) {
  const user = await requireFormUser(data, 'admin'); rejectDemo(user, data); const id = val(data, 'id'), status = val(data, 'status'), response = val(data, 'response');
  if (!validId(id) || !['Open', 'In Progress', 'Resolved'].includes(status)) done(data, 'support', 'Invalid support update.', 'error');
  await db.update(supportRequests).set({ status, response: response || null }).where(eq(supportRequests.id, id));
  done(data, 'support', 'Support request updated.');
}

function refreshCatalogue() { for (const path of ['/', '/services', '/professionals', '/signup', '/request-quote']) revalidatePath(path); }
export async function createCategoryAction(data: FormData) {
  const user = await requireFormUser(data, 'admin'); rejectDemo(user, data);
  const name = val(data, 'name'), description = val(data, 'description');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120);
  if (!name || name.length > 100 || !description || description.length > 255 || !slug) done(data, 'categories', 'Provide a valid category name and description.', 'error');
  try { await db.insert(serviceCategories).values({ name, slug, description, icon: 'Wrench', tone: 'mint' }); }
  catch { done(data, 'categories', 'A category with that name already exists.', 'error'); }
  refreshCatalogue(); done(data, 'categories', 'Service category added.');
}
export async function updateCategoryAction(data: FormData) {
  const user = await requireFormUser(data, 'admin'); rejectDemo(user, data);
  const id = val(data, 'id'), name = val(data, 'name'), description = val(data, 'description');
  if (!validId(id) || !name || name.length > 100 || !description || description.length > 255) done(data, 'categories', 'Provide a valid name and description.', 'error');
  const [old] = await db.select().from(serviceCategories).where(eq(serviceCategories.id, id)).limit(1);
  if (!old) done(data, 'categories', 'Category not found.', 'error');
  try { await db.transaction(async tx => {
    await tx.update(serviceCategories).set({ name, description }).where(eq(serviceCategories.id, id));
    if (old.name !== name) {
      await tx.update(providers).set({ category: name }).where(eq(providers.category, old.name));
      await tx.update(quoteRequests).set({ category: name }).where(eq(quoteRequests.category, old.name));
    }
  }); } catch { done(data, 'categories', 'A category with that name already exists.', 'error'); }
  refreshCatalogue(); done(data, 'categories', 'Service category updated.');
}
export async function toggleCategoryAction(data: FormData) {
  const user = await requireFormUser(data, 'admin'); rejectDemo(user, data); const id = val(data, 'id');
  if (!validId(id)) done(data, 'categories', 'Category not found.', 'error');
  await db.update(serviceCategories).set({ isActive: val(data, 'active') === 'true' }).where(eq(serviceCategories.id, id));
  refreshCatalogue(); done(data, 'categories', 'Service category status updated.');
}
