(function () {
    'use strict';

    const USERS_STORAGE_KEY = 'onruf_users_v1';
    const SESSION_STORAGE_KEY = 'onruf_active_session_v1';
    const OTP_EXPIRY_MINUTES = 10;
    const DATA_RESET_VERSION = '20251114-individual-market-activity';
    const DATA_RESET_KEY = 'onruf_data_reset_version';
    const INVITATION_SERVICE_ENDPOINT_DEFAULT = '/api/invitations/send';
    const INVITATION_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;
    const PASSWORD_POLICY_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;

    function resolveInvitationServiceUrl() {
        try {
            const config = window.__ONRUF_CONFIG__;
            if (config) {
                const value = config.invitationServiceUrl;
                if (typeof value === 'string') {
                    const trimmed = value.trim();
                    if (trimmed.length > 0) {
                        return trimmed;
                    }
                    return null;
                }
                if (value === null) {
                    return null;
                }
            }
        } catch (error) {
            console.warn('Unable to read window.__ONRUF_CONFIG__.invitationServiceUrl', error);
        }
        if (typeof window !== 'undefined' && window.location && window.location.protocol === 'file:') {
            return null;
        }
        return INVITATION_SERVICE_ENDPOINT_DEFAULT;
    }

    function buildAbsoluteInvitationLink(token) {
        if (!token) {
            return window.location.href.split('#')[0];
        }
        try {
            const currentUrl = new URL(window.location.href);
            currentUrl.searchParams.set('token', token);
            currentUrl.hash = '';
            return currentUrl.toString();
        } catch (error) {
            console.warn('Unable to construct absolute invitation link.', error);
            const base = window.location.origin || '';
            return `${base}/complete-registration.html?token=${encodeURIComponent(token)}`;
        }
    }

    async function deliverInvitationEmail(user, meta = {}) {
        if (!user || !user.email) {
            return { status: 'skipped', message: 'Recipient email missing.' };
        }

        const endpoint = resolveInvitationServiceUrl();
        if (!endpoint) {
            return { status: 'skipped', message: 'Invitation service not configured.' };
        }

        const payload = {
            recipientEmail: user.email,
            recipientName: user.name || `${user.firstName || ''} ${user.lastName || ''}`.trim() || null,
            invitationLink: buildAbsoluteInvitationLink(meta.token || (user.invitation && user.invitation.token)),
            otp: meta.otp || null,
            expiresAt: meta.expiresAt || null,
            linkExpiresAt: meta.linkExpiresAt || (user.invitation && user.invitation.expiresAt) || null,
            invitedBy: meta.invitedBy || null
        };

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            let responseBody = null;
            try {
                responseBody = await response.json();
            } catch (parseError) {
                responseBody = null;
            }

            if (!response.ok) {
                const details = responseBody && (responseBody.error || responseBody.details);
                const message = details || `Service returned status ${response.status}.`;
                return { status: 'error', message };
            }

            return {
                status: 'sent',
                messageId: responseBody && responseBody.messageId ? responseBody.messageId : null
            };
        } catch (error) {
            console.error('Unable to deliver invitation email.', error);
            return { status: 'error', message: error.message };
        }
    }

    const DEFAULT_USERS_SEED = [
        {
            id: 1,
            name: 'Central Super Admin',
            firstName: 'Central',
            lastName: 'Admin',
            email: 'superadmin@onruf.com',
            role: 'Super Administrator',
            accountType: 'platform-administrator',
            status: 'active',
            department: 'Central Governance',
            phone: '+966500000001',
            employeeId: 'CSA-001',
            permissionSummary: 'Full platform access',
            created: '2025-10-05',
            lastLogin: 'Never',
            sessionExpiresAt: null,
            invitation: {
                token: 'reg-super-admin-seed',
                sentAt: '2025-10-05T00:00:00.000Z',
                expiresAt: '2025-10-12T00:00:00.000Z',
                completedAt: '2025-10-05T00:00:00.000Z',
                verifiedAt: '2025-10-05T00:00:00.000Z',
                otp: null,
                lastOtpSentAt: null
            },
            auth: {
                passwordHash: 'QWRtaW5AMTIz',
                lastUpdated: '2025-10-05T00:00:00.000Z'
            }
        }
    ];

    const body = document.body;
    if (!body) {
        return;
    }

    const pageType = body.dataset.authPage || '';

    function seedDefaultUsers() {
        try {
            localStorage.setItem(USERS_STORAGE_KEY, JSON.stringify(DEFAULT_USERS_SEED));
        } catch (error) {
            console.warn('Unable to seed default users.', error);
        }
    }

    function ensureSeedDataReset() {
        try {
            const recordedVersion = localStorage.getItem(DATA_RESET_KEY);
            if (recordedVersion !== DATA_RESET_VERSION) {
                localStorage.removeItem(USERS_STORAGE_KEY);
                localStorage.setItem(DATA_RESET_KEY, DATA_RESET_VERSION);
                seedDefaultUsers();
                return;
            }
            const existingUsers = localStorage.getItem(USERS_STORAGE_KEY);
            if (!existingUsers) {
                seedDefaultUsers();
            }
        } catch (error) {
            console.warn('Unable to enforce seed data reset.', error);
        }
    }

    ensureSeedDataReset();

    const authState = {
        users: loadUsersFromStorage(),
        currentUser: null,
        otp: null,
        otpExpiresAt: null,
        token: null,
        tokenStatus: 'unknown',
        pendingPersonalData: null
    };

    let otpCountdownInterval = null;

    const toastEl = document.getElementById('authToast');

    function loadUsersFromStorage() {
        try {
            const raw = localStorage.getItem(USERS_STORAGE_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            const users = Array.isArray(parsed) ? parsed : [];
            const superAdmin = users.find(user => typeof user.email === 'string' && user.email.trim().toLowerCase() === 'superadmin@onruf.com');
            let modified = false;
            if (superAdmin && (!superAdmin.status || superAdmin.status.toLowerCase() !== 'active')) {
                superAdmin.status = 'Active';
                if (!superAdmin.accountType || superAdmin.accountType === 'pending-invite') {
                    superAdmin.accountType = 'platform-administrator';
                }
                modified = true;
            }
            users.forEach(user => {
                if (ensureInvitationObject(user)) {
                    modified = true;
                }
            });
            if (modified) {
                try {
                    localStorage.setItem(USERS_STORAGE_KEY, JSON.stringify(users));
                } catch (persistError) {
                    console.warn('Unable to persist invitation updates', persistError);
                }
            }
            return users;
        } catch (error) {
            console.warn('Unable to load users from storage', error);
            return [];
        }
    }

    function saveUsersToStorage() {
        try {
            localStorage.setItem(USERS_STORAGE_KEY, JSON.stringify(authState.users));
        } catch (error) {
            console.warn('Unable to persist user updates', error);
        }
    }

    function formatDateTime(value) {
        const date = value ? new Date(value) : new Date();
        if (Number.isNaN(date.getTime())) {
            return value || '';
        }
        const datePart = date.toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
        const timePart = date.toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit'
        });
        return `${datePart} ${timePart}`.trim();
    }

    function hashPassword(value) {
        if (typeof value !== 'string') {
            return '';
        }
        const normalized = value.normalize('NFKC');
        const encoder = new TextEncoder();
        const bytes = encoder.encode(normalized);
        let binary = '';
        bytes.forEach(byte => {
            binary += String.fromCharCode(byte);
        });
        return btoa(binary);
    }

    function verifyPassword(user, plain) {
        if (!user || !user.auth || !user.auth.passwordHash) {
            return false;
        }
        return hashPassword(plain) === user.auth.passwordHash;
    }

    function generateOtp() {
        return String(Math.floor(100000 + Math.random() * 900000));
    }

    function showToast(type, message, timeout = 3500) {
        if (!toastEl) {
            return;
        }
        toastEl.classList.remove('hidden', 'visible', 'success', 'error', 'info');
        if (type) {
            toastEl.classList.add(type);
        }
        toastEl.textContent = message;
        requestAnimationFrame(() => {
            toastEl.classList.add('visible');
        });
        window.clearTimeout(toastEl._timeoutId);
        toastEl._timeoutId = window.setTimeout(() => {
            toastEl.classList.remove('visible');
        }, timeout);
    }

    function setFieldErrorState(input, errorElement, message) {
        if (!input || !errorElement) {
            return;
        }
        if (message) {
            errorElement.textContent = message;
            errorElement.classList.remove('hidden');
            input.classList.add('input-error');
        } else {
            errorElement.textContent = '';
            errorElement.classList.add('hidden');
            input.classList.remove('input-error');
        }
    }

    function applyRegistrationRequiredIndicators() {
        const form = document.getElementById('registrationAccountForm');
        if (!form) {
            return;
        }
        const requiredFields = form.querySelectorAll('input[required], select[required], textarea[required]');
        requiredFields.forEach(field => {
            const label = field.id ? form.querySelector(`label[for="${field.id}"]`) : field.closest('label');
            if (!label) {
                return;
            }
            const isAgreementField = label.id === 'registrationPrivacyAgreeLabel' || field.id === 'registrationPrivacyAgree';
            if (isAgreementField) {
                label.classList.remove('required');
                return;
            }
            if (!label.classList.contains('required')) {
                label.classList.add('required');
            }
        });
    }

    function attachPasswordToggle(button) {
        if (!button) return;
        const targetId = button.dataset.toggleTarget;
        const showIcon = button.querySelector('.password-icon-show');
        const hideIcon = button.querySelector('.password-icon-hide');

        const updateToggleState = input => {
            if (!input) return;
            const isHidden = input.type === 'password';
            if (showIcon) {
                showIcon.classList.toggle('hidden', !isHidden);
            }
            if (hideIcon) {
                hideIcon.classList.toggle('hidden', isHidden);
            }
            button.setAttribute('aria-label', isHidden ? 'Show password' : 'Hide password');
            button.setAttribute('aria-pressed', isHidden ? 'false' : 'true');
        };

        button.addEventListener('click', () => {
            const input = targetId ? document.getElementById(targetId) : button.previousElementSibling;
            if (!input) return;
            const isHidden = input.type === 'password';
            input.type = isHidden ? 'text' : 'password';
            updateToggleState(input);
            input.focus();
        });

        const initialInput = targetId ? document.getElementById(targetId) : button.previousElementSibling;
        if (initialInput) {
            updateToggleState(initialInput);
        }
    }

    function handleOtpBack() {
        resetOtpCountdown();
        setRegistrationStep('account');
        
        // Restore pending personal data to form inputs if user goes back
        if (authState.pendingPersonalData) {
            const firstNameInput = document.getElementById('registrationFirstName');
            const lastNameInput = document.getElementById('registrationLastName');
            const phoneInput = document.getElementById('registrationPhone');
            const genderInputs = document.querySelectorAll('input[name="registrationGender"]');
            if (firstNameInput) firstNameInput.value = authState.pendingPersonalData.firstName || '';
            if (lastNameInput) lastNameInput.value = authState.pendingPersonalData.lastName || '';
            if (phoneInput) phoneInput.value = authState.pendingPersonalData.phone || '';
            if (genderInputs.length) {
                genderInputs.forEach(input => {
                    input.checked = input.value === (authState.pendingPersonalData.gender || '');
                });
            }
        }
        
        const firstNameInput = document.getElementById('registrationFirstName');
        if (firstNameInput) {
            firstNameInput.focus();
        }
    }

    function setupSharedToggles() {
        document.querySelectorAll('.input-toggle').forEach(btn => attachPasswordToggle(btn));
    }

    function setupPrivacyModal() {
        const modal = document.getElementById('registrationPrivacyModal');
        if (!modal || modal.dataset.setupComplete === 'true') {
            return;
        }

        const openLink = document.getElementById('registrationPrivacyLink');
        const closeButton = document.getElementById('privacyModalClose');
        const acknowledgeButton = document.getElementById('privacyModalAcknowledge');
        const focusTarget = modal.querySelector('[data-modal-focus]') || closeButton || acknowledgeButton;

        if (!openLink) {
            return;
        }

        const closeModal = () => {
            if (modal.classList.contains('hidden')) {
                return;
            }
            modal.classList.add('hidden');
            document.body.classList.remove('modal-open');
            window.setTimeout(() => {
                openLink.focus();
            }, 0);
        };

        const openModal = event => {
            if (event) {
                event.preventDefault();
            }
            if (!modal.classList.contains('hidden')) {
                return;
            }
            modal.classList.remove('hidden');
            document.body.classList.add('modal-open');
            window.setTimeout(() => {
                focusTarget?.focus();
            }, 0);
        };

        openLink.addEventListener('click', openModal);

        [closeButton, acknowledgeButton].forEach(button => {
            if (!button) {
                return;
            }
            button.addEventListener('click', () => {
                closeModal();
            });
        });

        modal.addEventListener('click', event => {
            if (event.target === modal) {
                closeModal();
            }
        });

        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !modal.classList.contains('hidden')) {
                closeModal();
            }
        });

        modal.dataset.setupComplete = 'true';
    }

    function findUserByEmail(email) {
        const normalized = (email || '').trim().toLowerCase();
        if (!normalized) return null;
        return authState.users.find(user => typeof user.email === 'string' && user.email.trim().toLowerCase() === normalized) || null;
    }

    function resolveInvitationByToken(token) {
        if (!token) {
            return { user: null, status: 'missing', revokedRecord: null };
        }

        const normalized = token.trim();
        if (!normalized) {
            return { user: null, status: 'missing', revokedRecord: null };
        }
        let matchedUser = null;
        let status = 'not-found';
        let revokedRecord = null;

        authState.users.some(user => {
            if (!user || !user.invitation) {
                return false;
            }

            const invitation = user.invitation;
            const activeToken = typeof invitation.token === 'string' ? invitation.token.trim() : '';
            if (activeToken && activeToken === normalized) {
                matchedUser = user;
                status = 'active';
                return true;
            }

            const revokedList = Array.isArray(invitation.revokedTokens) ? invitation.revokedTokens : [];
            const revokedMatch = revokedList.find(entry => {
                if (!entry) {
                    return false;
                }
                if (typeof entry === 'string') {
                    return entry.trim() === normalized;
                }
                if (typeof entry === 'object') {
                    const value = typeof entry.token === 'string' ? entry.token.trim() : '';
                    return value && value === normalized;
                }
                return false;
            });

            if (revokedMatch) {
                matchedUser = user;
                status = 'revoked';
                revokedRecord = typeof revokedMatch === 'object' ? revokedMatch : { token: normalized, revokedAt: null };
                return true;
            }

            return false;
        });

        return { user: matchedUser, status, revokedRecord };
    }

    function findUserByToken(token) {
        const result = resolveInvitationByToken(token);
        return result.status === 'active' ? result.user : null;
    }

    function resolveInvitationByToken(token) {
        if (!token) {
            return { user: null, status: 'missing' };
        }

        const normalized = token.trim();
        let matchedUser = null;
        let status = 'not-found';

        authState.users.some(user => {
            if (!user || !user.invitation) {
                return false;
            }

            const invitation = user.invitation;
            const activeToken = typeof invitation.token === 'string' ? invitation.token.trim() : '';
            if (activeToken && activeToken === normalized) {
                matchedUser = user;
                status = 'active';
                return true;
            }

            const revokedList = Array.isArray(invitation.revokedTokens) ? invitation.revokedTokens : [];
            const revokedMatch = revokedList.find(entry => {
                if (!entry) {
                    return false;
                }
                if (typeof entry === 'string') {
                    return entry.trim() === normalized;
                }
                if (typeof entry === 'object') {
                    const value = typeof entry.token === 'string' ? entry.token.trim() : '';
                    return value && value === normalized;
                }
                return false;
            });

            if (revokedMatch) {
                matchedUser = user;
                status = 'revoked';
                return true;
            }

            return false;
        });

        return { user: matchedUser, status };
    }

    function persistAuthSession(user) {
        if (!user) {
            sessionStorage.removeItem(SESSION_STORAGE_KEY);
            return;
        }
        const payload = {
            userId: user.id,
            email: user.email,
            signedInAt: new Date().toISOString()
        };
        sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload));
    }

    function setupLoginPage() {
        const emailInput = document.getElementById('loginEmail');
        const passwordInput = document.getElementById('loginPassword');
        const rememberCheckbox = document.getElementById('loginRemember');
        const form = document.getElementById('loginForm');
        const helpBtn = document.getElementById('authHelpBtn');
        const forgotLink = document.getElementById('forgotPasswordLink');

        setupSharedToggles();

        if (helpBtn) {
            helpBtn.addEventListener('click', () => {
                showToast('info', 'Need help? Email support@onruf.com and our team will respond within an hour.');
            });
        }

        if (forgotLink) {
            forgotLink.addEventListener('click', event => {
                event.preventDefault();
                showToast('info', 'Password resets are handled by your account administrator.');
            });
        }

        if (!form || !emailInput || !passwordInput) {
            return;
        }

        form.addEventListener('submit', event => {
            event.preventDefault();
            const email = emailInput.value.trim();
            const password = passwordInput.value;

            if (!email) {
                showToast('error', 'Enter your email address to continue.');
                emailInput.focus();
                return;
            }
            if (!password) {
                showToast('error', 'Enter your password to sign in.');
                passwordInput.focus();
                return;
            }

            const user = findUserByEmail(email);
            if (!user) {
                showToast('error', 'We could not find an account with that email.');
                return;
            }

            const status = (user.status || '').toLowerCase();
            if (status === 'pending') {
                showToast('error', 'Your invitation is pending. Complete your registration from the invitation email.');
                return;
            }
            if (status === 'inactive') {
                showToast('error', 'This account is inactive. Contact your administrator for access.');
                return;
            }

            if (!verifyPassword(user, password)) {
                showToast('error', 'Incorrect password. Please try again.');
                passwordInput.select();
                return;
            }

            user.lastLogin = formatDateTime(new Date());
            if (rememberCheckbox && rememberCheckbox.checked) {
                user.sessionExpiresAt = Date.now() + 14 * 24 * 60 * 60 * 1000;
            }

            saveUsersToStorage();
            persistAuthSession(user);

            showToast('success', 'Signed in successfully. Redirecting…', 1800);
            setTimeout(() => {
                window.location.href = 'index.html';
            }, 1400);
        });
    }

    function setStatusPill(type, text) {
        const pill = document.getElementById('registrationStatusPill');
        if (!pill) return;
        pill.classList.remove('success', 'warning', 'hidden');
        if (!text) {
            pill.innerHTML = '';
            pill.classList.add('hidden');
            return;
        }
        pill.innerHTML = text;
        if (type) {
            pill.classList.add(type);
        }
    }

    function renderSummary(user) {
        const roleEl = document.getElementById('summaryRole');
        const sentAtEl = document.getElementById('summarySentAt');
    const departmentEl = document.getElementById('summaryDepartment');
        const expiresEl = document.getElementById('summaryExpiresOn');
        const employeeIdEl = document.getElementById('summaryEmployeeId');
    const invitationExpiresEl = document.getElementById('summaryInvitationExpiresAt');

        if (roleEl) {
            const rawRole = typeof user.role === 'string' ? user.role.trim() : '';
            const simplifiedRole = rawRole ? rawRole.replace(/\s*\([^)]*\)\s*$/, '').trim() : '';
            roleEl.textContent = simplifiedRole || rawRole || 'Pending role';
        }
        if (sentAtEl) {
            sentAtEl.textContent = user.invitation && user.invitation.sentAt ? formatDateTime(user.invitation.sentAt) : '—';
        }
        if (departmentEl) {
            const department = user.department || (user.organization && user.organization.department) || '';
            departmentEl.textContent = department || '—';
        }
        if (expiresEl) {
            expiresEl.textContent = user.expiresOn ? formatDateTime(user.expiresOn) : '—';
        }
        if (invitationExpiresEl) {
            const invitationExpiresAt = user.invitation && user.invitation.expiresAt ? user.invitation.expiresAt : null;
            invitationExpiresEl.textContent = invitationExpiresAt ? formatDateTime(invitationExpiresAt) : '—';
        }
        if (employeeIdEl) {
            const employeeId = user.employeeId || (user.organization && user.organization.employeeId) || '';
            employeeIdEl.textContent = employeeId ? String(employeeId) : '—';
        }
    }

    function showAlert(type, message) {
        const container = document.getElementById('registrationAlertContainer');
        if (!container) {
            return;
        }
        container.innerHTML = '';
        if (!message) {
            container.classList.add('hidden');
            return;
        }
        const alert = document.createElement('div');
        alert.className = `alert-box ${type || ''}`.trim();
        alert.innerHTML = `<strong>${message}</strong>`;
        container.appendChild(alert);
        container.classList.remove('hidden');
    }

    function setRegistrationStep(step) {
        const account = document.getElementById('registrationStepAccount');
        const otp = document.getElementById('registrationStepOtp');

        if (account) account.classList.toggle('hidden', step !== 'account');
        if (otp) otp.classList.toggle('hidden', step !== 'otp');

        if (step === 'otp') {
            startOtpCountdown();
        } else {
            resetOtpCountdown();
        }
    }

    function collectOtpValue() {
        const inputs = Array.from(document.querySelectorAll('#otpInputGroup input'));
        if (!inputs.length) {
            return '';
        }
        return inputs.map(input => input.value.trim()).join('');
    }

    function resetOtpInputs(code) {
        const inputs = Array.from(document.querySelectorAll('#otpInputGroup input'));
        inputs.forEach((input, index) => {
            input.value = code ? code[index] || '' : '';
        });
        if (inputs.length) {
            inputs[0].focus();
            inputs[0].select();
        }
    }

    function getOtpCountdownElement() {
        return document.getElementById('otpCountdown');
    }

    function setResendButtonDisabled(disabled) {
        const resendBtn = document.getElementById('registrationResendOtp');
        if (!resendBtn) {
            return;
        }
        resendBtn.disabled = !!disabled;
    }

    function stopOtpCountdown() {
        if (otpCountdownInterval !== null) {
            clearInterval(otpCountdownInterval);
            otpCountdownInterval = null;
        }
    }

    function resetOtpCountdown() {
        stopOtpCountdown();
        const countdownEl = getOtpCountdownElement();
        if (countdownEl) {
            const fallback = countdownEl.dataset.default || '--:--';
            countdownEl.textContent = fallback;
            countdownEl.classList.remove('expired');
        }
        setResendButtonDisabled(true);
    }

    function startOtpCountdown() {
        const countdownEl = getOtpCountdownElement();
        if (!countdownEl) {
            return;
        }

        stopOtpCountdown();

        if (!authState.otpExpiresAt) {
            resetOtpCountdown();
            setResendButtonDisabled(false);
            return;
        }

        setResendButtonDisabled(true);

        const update = () => {
            const remainingMs = authState.otpExpiresAt - Date.now();
            if (remainingMs <= 0) {
                countdownEl.textContent = 'Expired';
                countdownEl.classList.add('expired');
                stopOtpCountdown();
                setResendButtonDisabled(false);
                return;
            }

            countdownEl.classList.remove('expired');
            const totalSeconds = Math.ceil(remainingMs / 1000);
            const minutes = Math.floor(totalSeconds / 60);
            const seconds = totalSeconds % 60;
            countdownEl.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        };

        update();

        otpCountdownInterval = window.setInterval(update, 1000);
    }

    function readFileAsDataUrl(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error || new Error('File reading failed'));
            reader.readAsDataURL(file);
        });
    }

    function updateOtpContactLabel(contactValue) {
        const label = document.getElementById('otpContactLabel');
        if (label) {
            const normalizedContact = typeof contactValue === 'string' ? contactValue.trim() : '';
            label.textContent = normalizedContact || '—';
        }
    }

    function updateHeadline(message) {
        const headline = document.getElementById('registrationHeadline');
        if (headline) {
            headline.textContent = message;
        }
    }

    function ensureUserAuthObject(user) {
        if (!user.auth) {
            user.auth = {
                passwordHash: '',
                lastUpdated: null
            };
        }
    }

    function ensureInvitationObject(user) {
        if (!user) {
            return false;
        }
        let modified = false;
        if (!user.invitation || typeof user.invitation !== 'object') {
            user.invitation = {};
            modified = true;
        }
        if (!user.invitation.token) {
            user.invitation.token = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
            modified = true;
        }
        if (!user.invitation.sentAt) {
            user.invitation.sentAt = new Date().toISOString();
            modified = true;
        }
        let sentTimestamp = user.invitation.sentAt ? Date.parse(user.invitation.sentAt) : NaN;
        if (!Number.isFinite(sentTimestamp)) {
            user.invitation.sentAt = new Date().toISOString();
            sentTimestamp = Date.parse(user.invitation.sentAt);
            modified = true;
        }
        const computeExpiry = () => {
            const base = Number.isFinite(sentTimestamp) ? sentTimestamp : Date.now();
            return new Date(base + INVITATION_VALIDITY_MS).toISOString();
        };
        if (!user.invitation.expiresAt) {
            user.invitation.expiresAt = computeExpiry();
            modified = true;
        } else {
            const expiresTimestamp = Date.parse(user.invitation.expiresAt);
            if (!Number.isFinite(expiresTimestamp)) {
                user.invitation.expiresAt = computeExpiry();
                modified = true;
            }
        }
        return modified;
    }

    function setupOtpInputBehavior() {
        const inputs = Array.from(document.querySelectorAll('#otpInputGroup input'));
        inputs.forEach((input, index) => {
            input.addEventListener('input', () => {
                const value = input.value.replace(/\D/g, '').slice(0, 1);
                input.value = value;
                if (value && index < inputs.length - 1) {
                    inputs[index + 1].focus();
                }
            });
            input.addEventListener('keydown', event => {
                if (event.key === 'Backspace' && !input.value && index > 0) {
                    inputs[index - 1].focus();
                    inputs[index - 1].value = '';
                    event.preventDefault();
                }
            });
        });
    }

    function getInvitationExpiryTimestamp(invitation) {
        if (!invitation) {
            return NaN;
        }
        if (invitation.expiresAt) {
            const expiresTimestamp = Date.parse(invitation.expiresAt);
            if (Number.isFinite(expiresTimestamp)) {
                return expiresTimestamp;
            }
        }
        if (invitation.sentAt) {
            const sentTimestamp = Date.parse(invitation.sentAt);
            if (Number.isFinite(sentTimestamp)) {
                return sentTimestamp + INVITATION_VALIDITY_MS;
            }
        }
        return NaN;
    }

    function isInvitationExpired(invitation) {
        const expiry = getInvitationExpiryTimestamp(invitation);
        if (!Number.isFinite(expiry)) {
            return false;
        }
        return Date.now() > expiry;
    }

    function isAccountExpired(user) {
        if (!user) {
            return false;
        }
        const expiresOn = user.expiresOn || (user.account && user.account.expiresOn);
        if (!expiresOn) {
            return false;
        }
        const expiryTimestamp = Date.parse(expiresOn);
        if (!Number.isFinite(expiryTimestamp)) {
            return false;
        }
        return Date.now() > expiryTimestamp;
    }

    function disableRegistrationForms() {
        const forms = [
            document.getElementById('registrationAccountForm'),
            document.getElementById('registrationOtpForm')
        ];
        forms.forEach(form => {
            if (!form) return;
            form.querySelectorAll('input, button, select, textarea').forEach(element => {
                element.disabled = true;
            });
        });
        const resendBtn = document.getElementById('registrationResendOtp');
        if (resendBtn) {
            resendBtn.disabled = true;
        }
    }

    function showInactiveInvitationView(options = {}) {
        const {
            title = 'Invitation link inactive',
            message = 'This invitation can no longer be used to finish registration.',
            statusMarkup = '<i class="fas fa-link-slash"></i> Invitation inactive',
            statusTone = 'warning',
            user = null
        } = options;

        authState.currentUser = user || null;
        authState.otp = null;
        authState.otpExpiresAt = null;

        disableRegistrationForms();
        resetOtpCountdown();

        setStatusPill(statusTone || 'warning', statusMarkup || '');
        updateHeadline('');
        showAlert(null, '');
        setRegistrationStep('account');

        const layout = document.querySelector('.registration-layout');
        if (layout) {
            layout.classList.add('hidden');
        }

        const inactiveContainer = document.getElementById('inactiveInvitationContainer');
        if (inactiveContainer) {
            inactiveContainer.classList.remove('hidden');
        }

        const messageEl = document.getElementById('inactiveInvitationMessage');
        if (messageEl) {
            messageEl.textContent = message;
        }

        const titleEl = document.getElementById('inactiveInvitationTitle');
        if (titleEl) {
            titleEl.textContent = title;
        }

        if (inactiveContainer && typeof inactiveContainer.scrollIntoView === 'function') {
            inactiveContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    function handleExpiredInvitation(user) {
        authState.tokenStatus = 'expired';
        showInactiveInvitationView({
            title: 'This invitation link has expired',
            message: 'The registration window for this invitation has closed. Please ask your administrator to send a new invitation.',
            statusMarkup: '<i class="fas fa-hourglass-end"></i> Invitation expired',
            statusTone: 'warning',
            user
        });
        showToast('error', 'This invitation link has expired. Request a new invitation from your administrator.', 6000);
    }

    // Fetch admin account data from API using userId and profileId
    async function fetchAdminAccountData(userId, profileId) {
        try {
            // Get API base URL from environment or use current origin
            const apiBaseUrl = window.__ONRUF_CONFIG__?.apiBaseUrl || window.location.origin;
            const url = `${apiBaseUrl}/api/AdminAccount/GetAllAdminAccounts`;
            
            // Get headers from localStorage or sessionStorage if available
            const providerId = localStorage.getItem('providerId') || sessionStorage.getItem('providerId') || 'a887d261-187d-4f3e-8551-3686ff1c14db';
            const businessAccountId = localStorage.getItem('businessAccountId') || sessionStorage.getItem('businessAccountId') || '';
            const userLanguage = localStorage.getItem('app_language') || localStorage.getItem('language') || localStorage.getItem('userLanguage') || 'en';
            const applicationSource = localStorage.getItem('applicationSource') || sessionStorage.getItem('applicationSource') || 'Admin';
            
            // Get auth token
            const TOKEN_KEYS = ['auth_token', 'token', 'jwt', 'access_token'];
            let authToken = null;
            for (const key of TOKEN_KEYS) {
                const value = localStorage.getItem(key) || sessionStorage.getItem(key);
                if (value) {
                    authToken = value.replace(/^\"|\"$/g, '').trim();
                    break;
                }
            }
            
            // Fallback to static token if not found
            if (!authToken) {
                authToken = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJIYWRlZXIiLCJ1c2VyX2lkIjoiYTg4N2QyNjEtMTg3ZC00ZjNlLTg1NTEtMzY4NmZmMWMxNGRiIiwidHlwZV91c2VyIjoiMSIsImV4cCI6MTc5ODEwOTUxNSwiaXNzIjoiaHR0cDovL3d3dy5zZWN1cml0eS5vcmciLCJhdWQiOiJodHRwOi8vd3d3LnNlY3VyaXR5Lm9yZyJ9.N0X1G-403B2L-DuebgyXHHsS4sE-MiBi3FnW-BMjb5w';
            } else if (!authToken.toLowerCase().startsWith('bearer')) {
                authToken = `Bearer ${authToken}`;
            }
            
            const headers = {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': authToken,
                'Provider-Id': providerId,
                'User-Language': userLanguage,
                'Application-Source': applicationSource
            };
            
            if (businessAccountId) {
                headers['Business-Account-Id'] = businessAccountId;
            }
            
            // Fetch all admin accounts and filter by userId
            const response = await fetch(url, {
                method: 'GET',
                headers: headers
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const result = await response.json();
            let accounts = [];
            
            // Handle different response structures
            if (Array.isArray(result)) {
                accounts = result;
            } else if (result?.data) {
                if (Array.isArray(result.data)) {
                    accounts = result.data;
                } else if (result.data?.result && Array.isArray(result.data.result)) {
                    accounts = result.data.result;
                }
            }

            // Find account matching userId and profileId
            const account = accounts.find(acc => 
                acc.userId === userId && 
                (profileId ? acc.profileId === parseInt(profileId) : true)
            );

            if (!account) {
                return null;
            }

            // Map API account to user object format expected by the form
            return {
                userId: account.userId,
                profileId: account.profileId,
                email: account.email || account.userName || '',
                firstName: account.firstName || '',
                lastName: account.lastName || '',
                phone: account.phoneNumber || '',
                userName: account.userName || account.email || '',
                roleName: account.roleName || '',
                departmentName: account.departmentName || '',
                employeeCode: account.employeeCode || '',
                expirationDate: account.expirationDate || null,
                invitation: {
                    sentAt: account.createdAt || new Date().toISOString(),
                    expiresAt: account.expirationDate || null
                }
            };
        } catch (error) {
            console.error('Error fetching admin account data:', error);
            return null;
        }
    }

    // Populate registration form with user data
    function populateRegistrationForm(user) {
        const layout = document.querySelector('.registration-layout');
        if (layout) {
            layout.classList.remove('hidden');
        }
        const inactiveContainer = document.getElementById('inactiveInvitationContainer');
        if (inactiveContainer) {
            inactiveContainer.classList.add('hidden');
        }

        authState.currentUser = user;
        ensureInvitationObject(user);
        ensureUserAuthObject(user);
        renderSummary(user);

        const firstNameInput = document.getElementById('registrationFirstName');
        const lastNameInput = document.getElementById('registrationLastName');
        const phoneInput = document.getElementById('registrationPhone');
        const emailDisplay = document.getElementById('registrationEmailDisplay');

        if (firstNameInput) firstNameInput.value = user.firstName || '';
        if (lastNameInput) lastNameInput.value = user.lastName || '';
        if (phoneInput) phoneInput.value = user.phone || '';
        if (emailDisplay) emailDisplay.value = user.email || '';

        const passwordInput = document.getElementById('registrationPassword');
        const passwordError = document.getElementById('registrationPasswordError');
        if (passwordInput && passwordError) {
            const handlePasswordBlurFeedback = () => {
                const value = passwordInput.value || '';
                if (!value) {
                    setFieldErrorState(passwordInput, passwordError, '');
                    return;
                }
                if (!PASSWORD_POLICY_REGEX.test(value)) {
                    setFieldErrorState(passwordInput, passwordError, 'Password Must be at Least 8 Characters Long and Contain Uppercase and Lowercase Letters, and at Least One Number');
                } else {
                    setFieldErrorState(passwordInput, passwordError, '');
                }
            };
            const clearPasswordFeedbackWhileTyping = () => {
                setFieldErrorState(passwordInput, passwordError, '');
            };
            passwordInput.addEventListener('input', clearPasswordFeedbackWhileTyping);
            passwordInput.addEventListener('blur', handlePasswordBlurFeedback);
        }

        if (isInvitationExpired(user.invitation)) {
            handleExpiredInvitation(user);
            return;
        }
    }

    function setupRegistrationPage() {
        setupSharedToggles();
        setupOtpInputBehavior();
        setupPrivacyModal();
        applyRegistrationRequiredIndicators();

        const params = new URLSearchParams(window.location.search);
        const token = params.get('token');
        const userId = params.get('userId');
        const profileId = params.get('profileId');
        
        authState.token = token ? token.trim() : null;

        // If userId and profileId are provided, fetch admin account data from API
        if (userId && profileId && !token) {
            fetchAdminAccountData(userId, profileId).then(user => {
                if (user) {
                    populateRegistrationForm(user);
                } else {
                    showInactiveInvitationView({
                        title: 'Invitation details missing',
                        message: 'Unable to load account information. Please contact your administrator for a fresh invitation.',
                        statusMarkup: '<i class="fas fa-triangle-exclamation"></i> Invalid invitation',
                        statusTone: 'warning'
                    });
                    showToast('error', 'Unable to load account information. Request a new invitation from your administrator.', 6000);
                }
            }).catch(error => {
                console.error('Error fetching admin account data:', error);
                showInactiveInvitationView({
                    title: 'Invitation details missing',
                    message: 'Unable to load account information. Please contact your administrator for a fresh invitation.',
                    statusMarkup: '<i class="fas fa-triangle-exclamation"></i> Invalid invitation',
                    statusTone: 'warning'
                });
                showToast('error', 'Unable to load account information. Request a new invitation from your administrator.', 6000);
            });
            return;
        }

        if (!token) {
            authState.tokenStatus = 'missing';
            showInactiveInvitationView({
                title: 'Invitation details missing',
                message: 'This invitation link is missing the required token. Please contact your administrator for a fresh invitation.',
                statusMarkup: '<i class="fas fa-triangle-exclamation"></i> Invalid invitation',
                statusTone: 'warning'
            });
            showToast('error', 'This invitation link is incomplete. Request a new invitation from your administrator.', 6000);
            return;
        }

        const tokenResult = resolveInvitationByToken(token);
        authState.tokenStatus = tokenResult.status;

        const layout = document.querySelector('.registration-layout');
        if (layout) {
            layout.classList.remove('hidden');
        }
        const inactiveContainer = document.getElementById('inactiveInvitationContainer');
        if (inactiveContainer) {
            inactiveContainer.classList.add('hidden');
        }

        if (tokenResult.status === 'not-found') {
            showInactiveInvitationView({
                title: 'The Invitation Link is Inactive',
                message: 'For More Information, Please Contact ONRUF Administrator',
                statusMarkup: '<i class="fas fa-link-slash"></i> Invitation inactive',
                statusTone: 'warning'
            });
            return;
        }

        if (tokenResult.status === 'revoked') {
            const revokedUser = tokenResult.user;
            showInactiveInvitationView({
                title: 'The Invitation Link is Inactive',
                message: 'For More Information, Please Contact ONRUF Administrator',
                statusMarkup: '<i class="fas fa-link-slash"></i> Invitation inactive',
                statusTone: 'warning',
                user: revokedUser || null
            });
            return;
        }

        if (tokenResult.status === 'missing') {
            showInactiveInvitationView({
                title: 'Invitation details missing',
                message: 'This invitation link is missing the required token. Please contact your administrator for a fresh invitation.',
                statusMarkup: '<i class="fas fa-triangle-exclamation"></i> Invalid invitation'
            });
            showToast('error', 'This invitation link is incomplete. Request a new invitation from your administrator.', 6000);
            return;
        }

        const user = tokenResult.user;
        if (!user) {
            showInactiveInvitationView({
                title: 'Invitation unavailable',
                message: 'We were unable to load this invitation. Please ask your administrator to resend it.',
                statusMarkup: '<i class="fas fa-link-slash"></i> Invitation inactive'
            });
            showToast('error', 'This invitation is no longer available. Request a new invitation from your administrator.', 6000);
            return;
        }

        authState.currentUser = user;
        ensureInvitationObject(user);
        ensureUserAuthObject(user);
        renderSummary(user);

        const firstNameInput = document.getElementById('registrationFirstName');
        const lastNameInput = document.getElementById('registrationLastName');
        const phoneInput = document.getElementById('registrationPhone');
        const emailDisplay = document.getElementById('registrationEmailDisplay');

        if (firstNameInput) firstNameInput.value = user.firstName || '';
        if (lastNameInput) lastNameInput.value = user.lastName || '';
        if (phoneInput) phoneInput.value = user.phone || '';
        if (emailDisplay) emailDisplay.value = user.email || '';

        const passwordInput = document.getElementById('registrationPassword');
        const passwordError = document.getElementById('registrationPasswordError');
        if (passwordInput && passwordError) {
            const handlePasswordBlurFeedback = () => {
                const value = passwordInput.value || '';
                if (!value) {
                    setFieldErrorState(passwordInput, passwordError, '');
                    return;
                }
                if (!PASSWORD_POLICY_REGEX.test(value)) {
                    setFieldErrorState(passwordInput, passwordError, 'Password Must be at Least 8 Characters Long and Contain Uppercase and Lowercase Letters, and at Least One Number');
                } else {
                    setFieldErrorState(passwordInput, passwordError, '');
                }
            };
            const clearPasswordFeedbackWhileTyping = () => {
                setFieldErrorState(passwordInput, passwordError, '');
            };
            passwordInput.addEventListener('input', clearPasswordFeedbackWhileTyping);
            passwordInput.addEventListener('blur', handlePasswordBlurFeedback);
        }

        if (isInvitationExpired(user.invitation)) {
            handleExpiredInvitation(user);
            return;
        }

        // Check if account has expired before registration completes
        if (isAccountExpired(user)) {
            showInactiveInvitationView({
                title: 'The Invitation Link is Inactive',
                message: 'For More Information, Please Contact ONRUF Administrator',
                statusMarkup: '<i class="fas fa-link-slash"></i> Invitation inactive',
                statusTone: 'warning',
                user
            });
            return;
        }

        updateHeadline('');
        setStatusPill('', '');

        if (user.status && user.status.toLowerCase() === 'active') {
            setStatusPill('success', '<i class="fas fa-circle-check"></i> Account already active');
            updateHeadline('This invitation has already been completed. Redirecting you to sign in.');
            showAlert('info', 'This invitation was already used. We\'ll take you to the login page.');
            resetOtpCountdown();
            showToast('info', 'Account already active. Redirecting to sign in...', 2200);
            window.location.href = 'login.html';
            return;
        }

        const accountForm = document.getElementById('registrationAccountForm');
        if (accountForm) {
            accountForm.addEventListener('submit', event => {
                event.preventDefault();
                handleRegistrationAccountSubmit().catch(error => {
                    console.error('Registration submission failed', error);
                    showToast('error', 'Something went wrong while saving your details. Please try again.');
                });
            });
        }

        const otpForm = document.getElementById('registrationOtpForm');
        if (otpForm) {
            otpForm.addEventListener('submit', event => {
                event.preventDefault();
                handleOtpSubmit();
            });
        }

        const resendBtn = document.getElementById('registrationResendOtp');
        if (resendBtn) {
            resendBtn.addEventListener('click', () => {
                resendOtp();
            });
        }

        const otpBackBtn = document.getElementById('registrationOtpBack');
        if (otpBackBtn) {
            otpBackBtn.addEventListener('click', () => {
                handleOtpBack();
            });
        }

    const initialContact = (user.phone && user.phone.trim()) ? user.phone.trim() : (user.email || '');
    updateOtpContactLabel(initialContact);
        setRegistrationStep('account');
    }

    async function handleRegistrationAccountSubmit() {
        const user = authState.currentUser;
        if (!user) {
            showToast('error', 'This invitation is no longer available.');
            return;
        }

        if (isInvitationExpired(user.invitation)) {
            handleExpiredInvitation(user);
            return;
        }


        const firstNameInput = document.getElementById('registrationFirstName');
        const lastNameInput = document.getElementById('registrationLastName');
        const phoneInput = document.getElementById('registrationPhone');
        const passwordInput = document.getElementById('registrationPassword');
        const confirmInput = document.getElementById('registrationPasswordConfirm');
        const photoInput = document.getElementById('registrationPhoto');
        const genderSelected = document.querySelector('input[name="registrationGender"]:checked');
        const passwordError = document.getElementById('registrationPasswordError');
        const confirmError = document.getElementById('registrationPasswordConfirmError');
    const privacyCheckbox = document.getElementById('registrationPrivacyAgree');

        const firstName = firstNameInput?.value.trim();
        const lastName = lastNameInput?.value.trim();
        const phone = phoneInput?.value.trim();
        const password = passwordInput?.value || '';
        const confirm = confirmInput?.value || '';
        const photoFile = photoInput?.files?.[0] || null;
        const gender = genderSelected ? genderSelected.value : '';

        setFieldErrorState(passwordInput, passwordError, '');
        setFieldErrorState(confirmInput, confirmError, '');

        if (!firstName) {
            showToast('error', 'First name is required.');
            firstNameInput?.focus();
            return;
        }
        if (!lastName) {
            showToast('error', 'Last name is required.');
            lastNameInput?.focus();
            return;
        }
        if (!phone) {
            showToast('error', 'Phone number is required.');
            phoneInput?.focus();
            return;
        }

        // basic E.164-ish validation: requires leading + and digits (8-15 digits total)
        const phoneNormalized = (phone || '').trim();
        const phoneValid = /^\+\d{8,15}$/.test(phoneNormalized);
        if (!phoneValid) {
            showToast('error', 'Please, Enter a Valid Phone Number');
            phoneInput?.focus();
            return;
        }

        // duplicate phone check (exclude the current user record if present)
        const duplicatePhone = authState.users.find(u => {
            if (!u || !u.phone) return false;
            if (authState.currentUser && u === authState.currentUser) return false;
            return (u.phone || '').trim() === phoneNormalized;
        });
        if (duplicatePhone) {
            showToast('error', 'This Phone Number is Already Registered');
            phoneInput?.focus();
            return;
        }

        if (!gender) {
            showToast('error', 'The Gender is Required');
            const genderFocus = document.getElementById('registrationGenderMale') || document.getElementById('registrationGenderFemale');
            genderFocus?.focus();
            return;
        }
        if (!password) {
            setFieldErrorState(passwordInput, passwordError, '');
            showToast('error', 'Please Enter your Password');
            passwordInput?.focus();
            return;
        }
        if (!PASSWORD_POLICY_REGEX.test(password)) {
            setFieldErrorState(passwordInput, passwordError, 'Password Must be at Least 8 Characters Long and Contain Uppercase and Lowercase Letters, and at Least One Number');
            passwordInput?.focus();
            return;
        }
        if (!confirm) {
            setFieldErrorState(confirmInput, confirmError, '');
            showToast('error', 'Please Confirm your Password');
            confirmInput?.focus();
            return;
        }
        if (password !== confirm) {
            setFieldErrorState(confirmInput, confirmError, '');
            showToast('error', 'Password Does not Match, Please Check Again');
            confirmInput?.focus();
            return;
        }

        if (!privacyCheckbox?.checked) {
            showToast('error', 'You Must Agree to The Privacy Policy and Terms and Conditions of Use');
            privacyCheckbox?.focus();
            return;
        }

        if (photoFile) {
            const isImage = photoFile.type ? photoFile.type.startsWith('image/') : false;
            if (!isImage) {
                showToast('error', 'Please choose a valid image file.');
                photoInput.value = '';
                return;
            }
            const maxSizeBytes = 5 * 1024 * 1024;
            if (photoFile.size > maxSizeBytes) {
                showToast('error', 'Photo must be 5 MB or smaller.');
                photoInput.value = '';
                return;
            }
        }

        // Store personal data temporarily in authState until OTP verification succeeds
        authState.pendingPersonalData = {
            firstName,
            lastName,
            phone,
            gender,
            photoFile: photoFile || null,
            photoDataUrl: null,
            photoFileName: photoFile ? photoFile.name : null
        };

        // Process photo if present, store in temporary object
        if (photoFile) {
            try {
                authState.pendingPersonalData.photoDataUrl = await readFileAsDataUrl(photoFile);
            } catch (error) {
                console.error('Failed to read uploaded photo', error);
                showToast('error', 'We could not read the selected photo. Please try again with a different image.');
                return;
            }
        }

        ensureUserAuthObject(user);
        user.auth.passwordHash = hashPassword(password);
        user.auth.lastUpdated = new Date().toISOString();

    ensureInvitationObject(user);
    user.invitation.lastOtpSentAt = new Date().toISOString();
        authState.otp = user.invitation.otp && String(user.invitation.otp).length === 6 ? String(user.invitation.otp) : generateOtp();
        user.invitation.otp = authState.otp;
        authState.otpExpiresAt = Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000;

        saveUsersToStorage();
        renderSummary(user);
        const otpContact = (authState.pendingPersonalData && typeof authState.pendingPersonalData.phone === 'string')
            ? authState.pendingPersonalData.phone.trim()
            : (user.phone || '');
    updateOtpContactLabel(otpContact);
        resetOtpInputs(authState.otp);
    showToast('success', 'Information Saved. A One-Time Verification Code has been sent to your Phone Number.', 3000);
        updateHeadline('');
        setStatusPill('', '');
        setRegistrationStep('otp');
    }

    function handleOtpSubmit() {
        const user = authState.currentUser;
        if (!user) {
            showToast('error', 'Invitation no longer available.');
            return;
        }

        if (isInvitationExpired(user.invitation)) {
            handleExpiredInvitation(user);
            return;
        }


        const entered = collectOtpValue();
        if (!/^[0-9]{6}$/.test(entered)) {
            showToast('error', 'Enter the 6-digit code to continue.');
            resetOtpInputs('');
            return;
        }

        if (authState.otp && entered !== authState.otp) {
            showToast('error', 'That code is incorrect. Please try again or resend.');
            resetOtpInputs('');
            return;
        }

        if (authState.otpExpiresAt && Date.now() > authState.otpExpiresAt) {
            showToast('error', 'The code has expired. Request a new one.');
            resetOtpInputs('');
            return;
        }

        // Now commit the pending personal data to the user record
        if (authState.pendingPersonalData) {
            user.firstName = authState.pendingPersonalData.firstName;
            user.lastName = authState.pendingPersonalData.lastName;
            user.name = `${authState.pendingPersonalData.firstName} ${authState.pendingPersonalData.lastName}`.trim();
            user.phone = authState.pendingPersonalData.phone;
            user.gender = authState.pendingPersonalData.gender || '';
            if (authState.pendingPersonalData.photoDataUrl) {
                user.photoDataUrl = authState.pendingPersonalData.photoDataUrl;
                user.photoFileName = authState.pendingPersonalData.photoFileName;
            }
            authState.pendingPersonalData = null;
        }

        user.status = 'Active';
        user.accountType = user.accountType === 'pending-invite' ? 'platform-user' : user.accountType;
    ensureInvitationObject(user);
    const verificationTimestamp = new Date().toISOString();
    user.invitation.completedAt = verificationTimestamp;
    user.invitation.verifiedAt = verificationTimestamp;
        user.lastLogin = 'Awaiting first login';

        saveUsersToStorage();
        renderSummary(user);
        setStatusPill('success', '<i class="fas fa-circle-check"></i> Account activated');
        // show the requested message then redirect after a short pause
        showToast('success', 'Registered Successfully, Redirecting…', 3000);
        resetOtpCountdown();
        window.setTimeout(() => {
            window.location.href = 'login.html';
        }, 2200);
    }

    async function resendOtp() {
        const user = authState.currentUser;
        if (!user) {
            showToast('error', 'Invitation not available.');
            return;
        }

        if (isInvitationExpired(user.invitation)) {
            handleExpiredInvitation(user);
            return;
        }

        authState.otp = generateOtp();
        authState.otpExpiresAt = Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000;
        ensureInvitationObject(user);
        user.invitation.otp = authState.otp;
        user.invitation.lastOtpSentAt = new Date().toISOString();

        saveUsersToStorage();
        renderSummary(user);
        resetOtpInputs(authState.otp);
        startOtpCountdown();
        const emailResult = await deliverInvitationEmail(user, {
            otp: authState.otp,
            expiresAt: authState.otpExpiresAt,
            token: user.invitation && user.invitation.token ? user.invitation.token : authState.token
        });

        if (emailResult.status === 'sent') {
            showToast('success', 'We emailed you a fresh verification code. Check your inbox.', 3200);
        } else if (emailResult.status === 'skipped') {
                setResendButtonDisabled(true);
            showToast('info', 'A new code is ready. Email delivery is disabled, so copy the code shown on screen.', 3600);
        } else {
            showToast('error', `We couldn\'t email the code: ${emailResult.message}. Use the code shown on screen.`, 4200);
        }
    }

    if (pageType === 'login') {
        setupLoginPage();
    } else if (pageType === 'registration') {
        setupRegistrationPage();
    }
})();
