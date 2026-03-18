const nodemailer = require('nodemailer');

jest.mock('nodemailer');

// Reset env before each test
const originalEnv = process.env;

beforeEach(() => {
  jest.resetModules();
  process.env = { ...originalEnv };
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_PORT;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASSWORD;
  delete process.env.SMTP_FROM;
  delete process.env.AINGRAM_GUI_ORIGIN;
});

afterAll(() => {
  process.env = originalEnv;
});

function loadEmailService() {
  // Re-require to pick up env changes
  jest.resetModules();
  jest.mock('nodemailer');
  return require('../email');
}

describe('email service', () => {
  describe('isConfigured', () => {
    it('should return false when SMTP vars are not set', () => {
      const emailService = loadEmailService();
      expect(emailService.isConfigured()).toBe(false);
    });

    it('should return true when all SMTP vars are set', () => {
      process.env.SMTP_HOST = 'smtp.gmail.com';
      process.env.SMTP_USER = 'user@gmail.com';
      process.env.SMTP_PASSWORD = 'app-password';
      const emailService = loadEmailService();
      expect(emailService.isConfigured()).toBe(true);
    });

    it('should return false when only SMTP_HOST is set', () => {
      process.env.SMTP_HOST = 'smtp.gmail.com';
      const emailService = loadEmailService();
      expect(emailService.isConfigured()).toBe(false);
    });
  });

  describe('sendConfirmationEmail', () => {
    it('should log instead of sending when SMTP is not configured', async () => {
      const emailService = loadEmailService();
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await emailService.sendConfirmationEmail(
        { owner_email: 'test@test.com', name: 'Test' },
        'fake-token'
      );

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Would send confirmation to test@test.com')
      );
      consoleSpy.mockRestore();
    });

    it('should send email when SMTP is configured', async () => {
      process.env.SMTP_HOST = 'smtp.gmail.com';
      process.env.SMTP_USER = 'sender@gmail.com';
      process.env.SMTP_PASSWORD = 'app-password';
      process.env.AINGRAM_GUI_ORIGIN = 'https://aingram.example.com';

      const mockSendMail = jest.fn().mockResolvedValue({ messageId: '123' });
      const mockNodemailer = require('nodemailer');
      mockNodemailer.createTransport.mockReturnValue({ sendMail: mockSendMail });

      const emailService = loadEmailService();
      // Re-mock after loadEmailService resets modules
      const nm = require('nodemailer');
      nm.createTransport.mockReturnValue({ sendMail: mockSendMail });

      await emailService.sendConfirmationEmail(
        { owner_email: 'user@test.com', name: 'TestUser' },
        'my-token-123'
      );

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user@test.com',
          subject: 'AIngram - Confirm your email',
          text: expect.stringContaining('https://aingram.example.com/confirm-email?token=my-token-123'),
        })
      );
    });

    it('should not throw on send failure', async () => {
      process.env.SMTP_HOST = 'smtp.gmail.com';
      process.env.SMTP_USER = 'sender@gmail.com';
      process.env.SMTP_PASSWORD = 'app-password';

      const mockSendMail = jest.fn().mockRejectedValue(new Error('SMTP error'));
      const nm = require('nodemailer');
      nm.createTransport.mockReturnValue({ sendMail: mockSendMail });

      const emailService = loadEmailService();
      const nm2 = require('nodemailer');
      nm2.createTransport.mockReturnValue({ sendMail: mockSendMail });

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      // Should not throw
      await emailService.sendConfirmationEmail(
        { owner_email: 'user@test.com', name: 'Test' },
        'token'
      );

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to send confirmation')
      );
      warnSpy.mockRestore();
    });
  });

  describe('sendPasswordResetEmail', () => {
    it('should log instead of sending when SMTP is not configured', async () => {
      const emailService = loadEmailService();
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await emailService.sendPasswordResetEmail('test@test.com', 'fake-token');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Would send password reset to test@test.com')
      );
      consoleSpy.mockRestore();
    });

    it('should send email when SMTP is configured', async () => {
      process.env.SMTP_HOST = 'smtp.gmail.com';
      process.env.SMTP_USER = 'sender@gmail.com';
      process.env.SMTP_PASSWORD = 'app-password';
      process.env.AINGRAM_GUI_ORIGIN = 'https://aingram.example.com';

      const mockSendMail = jest.fn().mockResolvedValue({ messageId: '456' });
      const nm = require('nodemailer');
      nm.createTransport.mockReturnValue({ sendMail: mockSendMail });

      const emailService = loadEmailService();
      const nm2 = require('nodemailer');
      nm2.createTransport.mockReturnValue({ sendMail: mockSendMail });

      await emailService.sendPasswordResetEmail('user@test.com', 'reset-token-456');

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user@test.com',
          subject: 'AIngram - Reset your password',
          text: expect.stringContaining('https://aingram.example.com/reset-password?token=reset-token-456'),
        })
      );
    });
  });
});
