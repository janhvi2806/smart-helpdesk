const express = require('express');
const Joi = require('joi');
const { v4: uuidv4 } = require('uuid');
const Ticket = require('../models/Ticket');
const AgentSuggestion = require('../models/AgentSuggestion');
const agentService = require('../services/agentService');
const auditService = require('../services/auditService');

const router = express.Router();

// Validation schemas
const createTicketSchema = Joi.object({
  title: Joi.string().min(5).max(200).required(),
  description: Joi.string().min(10).max(2000).required(),
  category: Joi.string().valid('billing', 'tech', 'shipping', 'other').optional(),
  attachmentUrls: Joi.array().items(Joi.string().uri()).optional()
});

const replySchema = Joi.object({
  content: Joi.string().min(5).max(2000).required(),
  changeStatus: Joi.string().valid('resolved', 'closed', 'waiting_human').optional()
});

// Create ticket
router.post('/', async (req, res) => {
  try {
    const { error, value } = createTicketSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const traceId = uuidv4();
    
    const ticket = new Ticket({
      ...value,
      createdBy: req.user.id,
      status: 'open'
    });

    await ticket.save();

    // Log ticket creation
    await auditService.log({
      ticketId: ticket._id,
      traceId,
      actor: 'user',
      action: 'TICKET_CREATED',
      meta: { userId: req.user.id, title: ticket.title }
    });

    // Queue triage
    await agentService.queueTriage(ticket._id, traceId);

    const populatedTicket = await Ticket.findById(ticket._id)
      .populate('createdBy', 'name email');

    res.status(201).json({ ticket: populatedTicket });
  } catch (error) {
    console.error('Create ticket error:', error);
    res.status(500).json({ error: 'Failed to create ticket' });
  }
});

// Get tickets
router.get('/', async (req, res) => {
  try {
    const { status, myTickets, page = 1, limit = 20 } = req.query;
    
    let filter = {};
    
    if (status) {
      filter.status = status;
    }
    
    if (myTickets === 'true') {
      if (req.user.role === 'user') {
        filter.createdBy = req.user.id;
      } else if (req.user.role === 'agent') {
        filter.assignee = req.user.id;
      }
    }

    const tickets = await Ticket.find(filter)
      .populate('createdBy', 'name email')
      .populate('assignee', 'name email')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Ticket.countDocuments(filter);

    res.json({
      tickets,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get tickets error:', error);
    res.status(500).json({ error: 'Failed to fetch tickets' });
  }
});

// Get single ticket
router.get('/:id', async (req, res) => {
  try {
    const ticket = await Ticket.findById(req.params.id)
      .populate('createdBy', 'name email')
      .populate('assignee', 'name email')
      .populate('replies.author', 'name email');

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    // Check permissions
    if (req.user.role === 'user' && ticket.createdBy._id.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get agent suggestion if exists
    let suggestion = null;
    if (ticket.agentSuggestionId) {
      suggestion = await AgentSuggestion.findById(ticket.agentSuggestionId)
        .populate('articleIds', 'title');
    }

    res.json({ ticket, suggestion });
  } catch (error) {
    console.error('Get ticket error:', error);
    res.status(500).json({ error: 'Failed to fetch ticket' });
  }
});

// Add reply (agents only)
router.post('/:id/reply', async (req, res) => {
  try {
    if (!['agent', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only agents can reply' });
    }

    const { error, value } = replySchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const { content, changeStatus } = value;
    const traceId = uuidv4();

    const ticket = await Ticket.findById(req.params.id);
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    // Add reply
    ticket.replies.push({
      author: req.user.id,
      content,
      isAgent: true
    });

    // Update status if requested
    if (changeStatus) {
      ticket.status = changeStatus;
    }

    ticket.updatedAt = new Date();
    await ticket.save();

    // Log reply
    await auditService.log({
      ticketId: ticket._id,
      traceId,
      actor: 'agent',
      action: 'REPLY_SENT',
      meta: {
        agentId: req.user.id,
        contentLength: content.length,
        newStatus: ticket.status
      }
    });

    const updatedTicket = await Ticket.findById(req.params.id)
      .populate('createdBy', 'name email')
      .populate('assignee', 'name email')
      .populate('replies.author', 'name email');

    res.json({ ticket: updatedTicket });
  } catch (error) {
    console.error('Add reply error:', error);
    res.status(500).json({ error: 'Failed to add reply' });
  }
});

// Assign ticket
router.post('/:id/assign', async (req, res) => {
  try {
    if (!['agent', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only agents can assign tickets' });
    }

    const { assigneeId } = req.body;
    const traceId = uuidv4();
    
    const ticket = await Ticket.findById(req.params.id);
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    ticket.assignee = assigneeId || req.user.id;
    ticket.status = 'waiting_human';
    ticket.updatedAt = new Date();
    
    await ticket.save();

    // Log assignment
    await auditService.log({
      ticketId: ticket._id,
      traceId,
      actor: 'agent',
      action: 'TICKET_ASSIGNED',
      meta: {
        assignerId: req.user.id,
        assigneeId: ticket.assignee
      }
    });

    const updatedTicket = await Ticket.findById(req.params.id)
      .populate('assignee', 'name email');

    res.json({ ticket: updatedTicket });
  } catch (error) {
    console.error('Assign ticket error:', error);
    res.status(500).json({ error: 'Failed to assign ticket' });
  }
});

module.exports = router;
